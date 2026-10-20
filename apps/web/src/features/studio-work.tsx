import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, HttpError, session } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import {
  dateInZone,
  isMilestoneOverdue,
  milestoneFields,
  savedMilestone,
  workQueue,
  type MilestoneFields,
  type MilestoneView,
  type WorkQueue,
} from '../../../../packages/shared/src/studio-milestones';
import './studio-work.css';

const headers = (accountId: string) => ({
  'X-PicFind-Studio-Actor': accountId,
});
const blank = (): MilestoneFields => {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return {
    projectId: '',
    title: '',
    note: '',
    dueDate: dateInZone(new Date(), timeZone),
    timeZone,
    status: 'open',
  };
};
async function readQueue(accountId: string, signal: AbortSignal) {
  const result = workQueue.parse(
    await api('/studio/milestones', { signal, headers: headers(accountId) }),
  );
  if (result.accountId !== accountId)
    throw new HttpError(
      403,
      'Your signed-in account changed. Reload the studio.',
    );
  return result;
}
export function StudioWork() {
  const account = useQuery({ queryKey: ['session'], queryFn: session });
  if (account.isPending) return <Loading />;
  if (!account.data || account.error)
    return (
      <ErrorNote
        error={account.error ?? new Error('Sign in to view your work queue.')}
      />
    );
  return <Queue key={account.data.id} accountId={account.data.id} />;
}
function Queue({ accountId }: { accountId: string }) {
  const query = useQuery({
    queryKey: ['studio-work', accountId],
    queryFn: ({ signal }) => readQueue(accountId, signal),
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  if (query.isPending) return <Loading />;
  if (query.error)
    return (
      <section className="glass-panel">
        <h1>Work queue</h1>
        <ErrorNote error={query.error} />
        <button className="button" onClick={() => void query.refetch()}>
          Retry work queue
        </button>
      </section>
    );
  return <WorkEditor key={accountId} initial={query.data} />;
}
function WorkEditor({ initial }: { initial: WorkQueue }) {
  const [queue, setQueue] = useState(initial);
  const [selected, setSelected] = useState<MilestoneView | null>(null);
  const [draft, setDraft] = useState<MilestoneFields>(blank);
  const [newId, setNewId] = useState(() => crypto.randomUUID());
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('open');
  const [projectFilter, setProjectFilter] = useState('');
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [denied, setDenied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    const refresh = () => setNow(new Date());
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  function choose(view: MilestoneView | null) {
    setSelected(view);
    const row = view?.milestone;
    setDraft(
      row
        ? {
            projectId: row.projectId,
            title: row.title,
            note: row.note,
            dueDate: row.dueDate,
            timeZone: row.timeZone,
            status: row.status,
          }
        : blank(),
    );
    setNewId(crypto.randomUUID());
    setConflict(false);
    setConfirmDelete(false);
    setError(null);
    setMessage('');
  }
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      await action(controller.signal);
    } catch (failure) {
      if (controller.signal.aborted) return;
      setError(failure);
      if (failure instanceof HttpError && failure.code === 'MILESTONE_CHANGED')
        setConflict(true);
      if (failure instanceof HttpError && [401, 403].includes(failure.status)) {
        setDenied(true);
        setQueue({ ...initial, milestones: [], projects: [], totalCount: 0 });
        setDraft(blank());
        setSelected(null);
      }
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function reload() {
    await run(async (signal) => {
      const latest = await readQueue(initial.accountId, signal);
      signal.throwIfAborted();
      setQueue(latest);
      choose(null);
      setDenied(false);
      setNow(new Date());
      setMessage('Latest work queue loaded.');
    });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (conflict || denied) return;
    await run(async (signal) => {
      const fields = milestoneFields.parse(draft);
      const id = selected?.milestone.id ?? newId;
      const result = await api<{ accountId: string; milestone: unknown }>(
        `/studio/milestones/${id}`,
        {
          method: 'PUT',
          signal,
          headers: headers(initial.accountId),
          body: JSON.stringify({
            ...fields,
            version: selected?.milestone.version ?? 0,
          }),
        },
      );
      signal.throwIfAborted();
      if (result.accountId !== initial.accountId)
        throw new HttpError(
          403,
          'Your signed-in account changed. Reload the studio.',
        );
      const saved = savedMilestone.parse(result.milestone);
      if (saved.id !== id)
        throw new Error(
          'The saved milestone did not match this draft. Reload the queue.',
        );
      const latest = await readQueue(initial.accountId, signal);
      signal.throwIfAborted();
      setQueue(latest);
      choose(
        latest.milestones.find((entry) => entry.milestone.id === id) ?? null,
      );
      setNow(new Date());
      setMessage('Private milestone saved.');
    });
  }
  async function remove() {
    if (!selected || !confirmDelete || conflict || denied) return;
    const target = selected.milestone;
    await run(async (signal) => {
      await api(`/studio/milestones/${target.id}`, {
        method: 'DELETE',
        signal,
        headers: headers(initial.accountId),
        body: JSON.stringify({ version: target.version }),
      });
      signal.throwIfAborted();
      // A subsequent refresh may fail. Do not leave a successfully removed record editable.
      setQueue((current) => ({
        ...current,
        totalCount: current.totalCount - 1,
        milestones: current.milestones.filter(
          (entry) => entry.milestone.id !== target.id,
        ),
      }));
      choose(null);
      const latest = await readQueue(initial.accountId, signal);
      signal.throwIfAborted();
      setQueue(latest);
      setMessage('Milestone removed.');
    });
  }
  if (denied)
    return (
      <section className="glass-panel">
        <h1>Work queue</h1>
        <ErrorNote error={error} />
        <p>Private work is hidden until your account is checked again.</p>
        <button
          className="button"
          disabled={busy}
          onClick={() => void reload()}
        >
          Reload work queue
        </button>
      </section>
    );
  const visible = queue.milestones.filter((view) => {
    const row = view.milestone;
    return (
      (filter === 'all' ||
        (filter === 'overdue'
          ? isMilestoneOverdue(view, now)
          : row.status === filter)) &&
      (!projectFilter || row.projectId === projectFilter) &&
      `${row.title} ${row.note} ${view.project?.name ?? ''}`
        .toLowerCase()
        .includes(search.trim().toLowerCase())
    );
  });
  const projectOptions = new Map(
    queue.projects.map((project) => [project.id, project.name]),
  );
  for (const view of queue.milestones)
    projectOptions.set(
      view.milestone.projectId,
      view.project?.name ?? 'Unavailable project',
    );
  const inactive =
    !!selected && (!selected.project || selected.project.stage === 'archived');
  const selectedMissing =
    selected &&
    !queue.projects.some(
      (project) => project.id === selected.milestone.projectId,
    );
  return (
    <section className="glass-panel studio-work">
      <h1>Work queue</h1>
      <p>
        Private milestones for your photography projects. A due date includes
        the whole day in its saved timezone. No client notifications are sent.
      </p>
      <p>
        {queue.milestones.length} of {queue.totalCount} milestones loaded.{' '}
        {
          queue.milestones.filter((view) => isMilestoneOverdue(view, now))
            .length
        }{' '}
        overdue among loaded milestones.
      </p>
      {queue.totalCount > queue.limit && (
        <p role="status">
          This queue exceeds its limit. Remove unused records and reload to
          reveal the remaining milestones.
        </p>
      )}
      <div className="studio-work-actions">
        <button
          className="button"
          disabled={busy || queue.totalCount >= queue.limit}
          onClick={() => choose(null)}
        >
          New milestone
        </button>
        <button
          className="button"
          disabled={busy}
          onClick={() => void reload()}
        >
          Reload and discard draft
        </button>
        <Link to="/app/projects">Manage projects</Link>
      </div>
      <ErrorNote error={error} />
      {message && <p role="status">{message}</p>}
      {conflict && (
        <p role="alert">
          Your draft is preserved. Reload the latest work queue before editing
          again.
        </p>
      )}
      <div className="studio-work-grid">
        <div>
          <label>
            Search work
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label>
            Work status
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            >
              <option value="open">Open</option>
              <option value="overdue">Overdue</option>
              <option value="completed">Completed</option>
              <option value="all">All retained</option>
            </select>
          </label>
          <label>
            Filter by project
            <select
              value={projectFilter}
              onChange={(event) => setProjectFilter(event.target.value)}
            >
              <option value="">All projects</option>
              {[...projectOptions].map(([id, name]) => (
                <option value={id} key={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <p>{visible.length} matching milestones</p>
          <ul className="studio-work-list" aria-label="Milestones">
            {visible.map((view) => {
              const row = view.milestone;
              return (
                <li key={row.id}>
                  <button
                    disabled={busy}
                    aria-pressed={selected?.milestone.id === row.id}
                    onClick={() => choose(view)}
                  >
                    <strong>{row.title}</strong>
                    <span>
                      {view.project?.name ?? 'Unavailable project'}
                      {view.project?.stage === 'archived' ? ' (archived)' : ''}
                    </span>
                    <span>
                      Due {row.dueDate} in {row.timeZone}
                    </span>
                    <span>
                      {isMilestoneOverdue(view, now)
                        ? 'Overdue'
                        : row.status === 'completed'
                          ? 'Completed'
                          : 'Open'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <form onSubmit={(event) => void save(event)}>
          <h2>{selected ? 'Edit milestone' : 'New milestone'}</h2>
          {inactive && (
            <p>
              This project is archived or unavailable. Restore an owned project
              before changing its milestones. You can still remove this record.
            </p>
          )}
          <fieldset
            disabled={
              busy ||
              conflict ||
              inactive ||
              (!selected && queue.totalCount >= queue.limit)
            }
          >
            <label>
              Milestone project
              <select
                required
                disabled={!!selected}
                value={draft.projectId}
                onChange={(event) =>
                  setDraft({ ...draft, projectId: event.target.value })
                }
              >
                <option value="">Choose a project</option>
                {selectedMissing && (
                  <option value={selected.milestone.projectId}>
                    {selected.project?.name ?? 'Unavailable project'}
                  </option>
                )}
                {queue.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            {!queue.projects.length && (
              <p>Create or restore a project to add work.</p>
            )}
            <label>
              Milestone title
              <input
                required
                maxLength={120}
                value={draft.title}
                onChange={(event) =>
                  setDraft({ ...draft, title: event.target.value })
                }
              />
            </label>
            <label>
              Private work note
              <textarea
                maxLength={1000}
                rows={3}
                value={draft.note}
                onChange={(event) =>
                  setDraft({ ...draft, note: event.target.value })
                }
              />
            </label>
            <label>
              Due date
              <input
                required
                type="date"
                value={draft.dueDate}
                onChange={(event) =>
                  setDraft({ ...draft, dueDate: event.target.value })
                }
              />
            </label>
            <label>
              Due timezone
              <input
                required
                maxLength={100}
                list="studio-timezones"
                value={draft.timeZone}
                onChange={(event) =>
                  setDraft({ ...draft, timeZone: event.target.value })
                }
              />
            </label>
            <datalist id="studio-timezones">
              {[
                'UTC',
                'Asia/Kolkata',
                'Europe/London',
                'America/New_York',
                'America/Los_Angeles',
                'Australia/Sydney',
              ].map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
            <p>
              Use an IANA timezone, such as Asia/Kolkata. The saved timezone
              stays with the milestone when you travel.
            </p>
            <label>
              Milestone status
              <select
                value={draft.status}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    status: event.target.value as MilestoneFields['status'],
                  })
                }
              >
                <option value="open">Open</option>
                <option value="completed">Completed</option>
              </select>
            </label>
            <button className="button primary" type="submit">
              Save milestone
            </button>
          </fieldset>
          {selected?.milestone.completedAt && (
            <p>
              Completed at{' '}
              {new Date(selected.milestone.completedAt).toLocaleString()} (your
              device time).
            </p>
          )}
          {selected && (
            <div className="studio-work-actions">
              {!confirmDelete ? (
                <button
                  className="button"
                  type="button"
                  disabled={busy || conflict}
                  onClick={() => setConfirmDelete(true)}
                >
                  Remove milestone
                </button>
              ) : (
                <>
                  <p>
                    Remove this private work record? The project and its photos
                    remain.
                  </p>
                  <button
                    className="button"
                    type="button"
                    disabled={busy || conflict}
                    onClick={() => void remove()}
                  >
                    Confirm removal
                  </button>
                  <button
                    className="button"
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmDelete(false)}
                  >
                    Keep milestone
                  </button>
                </>
              )}
            </div>
          )}
        </form>
      </div>
    </section>
  );
}
