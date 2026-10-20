import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, HttpError, session } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import {
  blankProject,
  backwardProjectStage,
  projectDirectory,
  projectWrite,
  savedProject,
  PROJECT_STAGES,
  type ProjectDirectory,
  type ProjectFields,
  type ProjectView,
} from '../../../../packages/shared/src/studio-projects';
import './studio-projects.css';

const label = (stage: string) => stage.charAt(0).toUpperCase() + stage.slice(1);
const headers = (accountId: string) => ({
  'X-PicFind-Studio-Actor': accountId,
});
async function readDirectory(accountId: string, signal: AbortSignal) {
  const result = projectDirectory.parse(
    await api('/studio/projects', { signal, headers: headers(accountId) }),
  );
  if (result.accountId !== accountId)
    throw new HttpError(
      403,
      'Your signed-in account changed. Reload the studio.',
    );
  return result;
}
export function StudioProjects() {
  const account = useQuery({ queryKey: ['session'], queryFn: session });
  if (account.isPending) return <Loading />;
  if (!account.data || account.error)
    return (
      <ErrorNote
        error={account.error ?? new Error('Sign in to view your projects.')}
      />
    );
  return <Directory key={account.data.id} accountId={account.data.id} />;
}
function Directory({ accountId }: { accountId: string }) {
  const query = useQuery({
    queryKey: ['studio-projects', accountId],
    queryFn: ({ signal }) => readDirectory(accountId, signal),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  if (query.isPending) return <Loading />;
  if (query.error)
    return (
      <section className="glass-panel">
        <h1>Projects</h1>
        <ErrorNote error={query.error} />
        <button
          type="button"
          className="button"
          onClick={() => void query.refetch()}
        >
          Retry projects
        </button>
      </section>
    );
  return <ProjectEditor initial={query.data} />;
}
function ProjectEditor({ initial }: { initial: ProjectDirectory }) {
  const [directory, setDirectory] = useState(initial);
  const [selected, setSelected] = useState<ProjectView | null>(null);
  const [draft, setDraft] = useState<ProjectFields>(blankProject);
  const [reason, setReason] = useState('');
  const [newId, setNewId] = useState(() => crypto.randomUUID());
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState('all');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [denied, setDenied] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  function choose(view: ProjectView | null) {
    setSelected(view);
    setDraft(
      view
        ? {
            name: view.project.name,
            summary: view.project.summary,
            clientId: view.project.clientId,
            eventIds: view.project.eventIds,
            stage: view.project.stage,
          }
        : blankProject(),
    );
    setReason('');
    setNewId(crypto.randomUUID());
    setConfirmRemove(false);
    setConflict(false);
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
      if (failure instanceof HttpError && failure.code === 'PROJECT_CHANGED')
        setConflict(true);
      if (failure instanceof HttpError && [401, 403].includes(failure.status)) {
        setDenied(true);
        setSelected(null);
        setDraft(blankProject());
        setReason('');
        setDirectory({
          ...initial,
          projects: [],
          clients: [],
          events: [],
          totalCount: 0,
        });
      }
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function reload() {
    await run(async (signal) => {
      const latest = await readDirectory(initial.accountId, signal);
      signal.throwIfAborted();
      setDirectory(latest);
      choose(null);
      setDenied(false);
      setMessage('Latest projects loaded.');
    });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (conflict || denied) return;
    await run(async (signal) => {
      const input = projectWrite.parse({
        ...draft,
        reason,
        version: selected?.project.version ?? 0,
      });
      const id = selected?.project.id ?? newId;
      const response = await api<{ accountId: string; project: unknown }>(
        `/studio/projects/${id}`,
        {
          method: 'PUT',
          signal,
          headers: headers(initial.accountId),
          body: JSON.stringify(input),
        },
      );
      signal.throwIfAborted();
      if (response.accountId !== initial.accountId)
        throw new HttpError(
          403,
          'Your signed-in account changed. Reload the studio.',
        );
      if (savedProject.parse(response.project).id !== id)
        throw new Error('The saved project response did not match this draft.');
      const latest = await readDirectory(initial.accountId, signal);
      signal.throwIfAborted();
      setDirectory(latest);
      const view =
        latest.projects.find((entry) => entry.project.id === id) ?? null;
      choose(view);
      setMessage(
        view
          ? 'Private project saved.'
          : 'Project saved, but it is no longer in the displayed list. Reload projects to check its current state.',
      );
    });
  }
  async function remove() {
    if (
      !selected ||
      !confirmRemove ||
      selected.project.stage !== 'archived' ||
      conflict ||
      denied
    )
      return;
    await run(async (signal) => {
      await api(`/studio/projects/${selected.project.id}`, {
        method: 'DELETE',
        signal,
        headers: headers(initial.accountId),
        body: JSON.stringify({ version: selected.project.version }),
      });
      signal.throwIfAborted();
      choose(null);
      const latest = await readDirectory(initial.accountId, signal);
      signal.throwIfAborted();
      setDirectory(latest);
      setMessage('Archived project record removed.');
    });
  }
  if (denied)
    return (
      <section className="glass-panel">
        <h1>Projects unavailable</h1>
        <ErrorNote error={error} />
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => void reload()}
        >
          Reload projects
        </button>
      </section>
    );
  const visible = directory.projects.filter(
    (view) =>
      (stageFilter === 'all' || view.project.stage === stageFilter) &&
      [view.project.name, view.project.summary, view.client?.name ?? ''].some(
        (value) =>
          value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
      ),
  );
  const eventChoices = [
    ...directory.events,
    ...draft.eventIds
      .filter((id) => !directory.events.some((event) => event.id === id))
      .map((id) => ({
        id,
        title:
          selected?.events.find((event) => event.id === id)?.title ??
          'Unavailable linked event',
      })),
  ];
  const backward =
    selected && backwardProjectStage(selected.project.stage, draft.stage);
  const edit = (fields: Partial<ProjectFields>) => {
    setDraft((current) => ({ ...current, ...fields }));
    setConfirmRemove(false);
  };
  return (
    <section className="glass-panel">
      <h1>Projects</h1>
      <p>
        Link your clients and events to a private work plan. Stages describe
        your workflow; they do not confirm payment, publication or file
        delivery.
      </p>
      <p>
        {directory.totalCount} / {directory.limit} project records.{' '}
        {directory.projects.length} available in this view.
      </p>
      {directory.totalCount > directory.projects.length && (
        <p className="notice">
          This view is bounded. Archive and remove unused projects to reveal
          older records and free capacity.
        </p>
      )}
      <button
        type="button"
        className="button secondary"
        disabled={busy}
        onClick={() => void reload()}
      >
        Load latest projects and discard draft
      </button>
      <ErrorNote error={error} />
      <p role="status">{message}</p>
      <div className="studio-project-grid">
        <div>
          <label>
            Search projects
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label>
            Filter by stage
            <select
              value={stageFilter}
              onChange={(event) => setStageFilter(event.target.value)}
            >
              <option value="all">All stages</option>
              {PROJECT_STAGES.map((stage) => (
                <option key={stage} value={stage}>
                  {label(stage)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="button"
            disabled={busy || directory.totalCount >= directory.limit}
            onClick={() => choose(null)}
          >
            New project
          </button>
          <p>{visible.length} matching projects in this view</p>
          <ul aria-label="Saved projects" className="studio-project-list">
            {visible.map((view) => (
              <li key={view.project.id}>
                <button
                  type="button"
                  disabled={busy}
                  aria-pressed={selected?.project.id === view.project.id}
                  onClick={() => choose(view)}
                >
                  <strong>{view.project.name}</strong>
                  <span>{label(view.project.stage)}</span>
                  <span>
                    {view.client
                      ? (view.client.name ?? 'Unavailable client')
                      : 'No client linked'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <form onSubmit={(event) => void save(event)}>
            <h2>{selected ? 'Edit project' : 'New project'}</h2>
            <fieldset disabled={busy}>
              <label>
                Project name
                <input
                  required
                  maxLength={100}
                  value={draft.name}
                  onChange={(event) => edit({ name: event.target.value })}
                />
              </label>
              <label>
                Private project brief
                <textarea
                  maxLength={1000}
                  value={draft.summary}
                  onChange={(event) => edit({ summary: event.target.value })}
                />
              </label>
              <label>
                Linked client
                <select
                  value={draft.clientId ?? ''}
                  onChange={(event) =>
                    edit({ clientId: event.target.value || null })
                  }
                >
                  <option value="">No client linked</option>
                  {draft.clientId &&
                    !directory.clients.some(
                      (client) => client.id === draft.clientId,
                    ) && (
                      <option value={draft.clientId}>
                        {selected?.client?.name ?? 'Unavailable linked client'}
                      </option>
                    )}
                  {directory.clients.map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.name}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset className="studio-project-events">
                <legend>Linked events ({draft.eventIds.length} / 20)</legend>
                {eventChoices.length === 0 && (
                  <p>Create an event to link it here.</p>
                )}
                {eventChoices.map((event) => (
                  <label key={event.id} className="studio-project-event-option">
                    <input
                      type="checkbox"
                      checked={draft.eventIds.includes(event.id)}
                      disabled={
                        !draft.eventIds.includes(event.id) &&
                        draft.eventIds.length >= 20
                      }
                      onChange={(change) =>
                        edit({
                          eventIds: change.target.checked
                            ? [...draft.eventIds, event.id]
                            : draft.eventIds.filter((id) => id !== event.id),
                        })
                      }
                    />
                    {event.title}
                  </label>
                ))}
              </fieldset>
              <label>
                Project stage
                <select
                  value={draft.stage}
                  onChange={(event) => {
                    edit({
                      stage: event.target.value as ProjectFields['stage'],
                    });
                    setReason('');
                  }}
                >
                  {PROJECT_STAGES.map((stage) => (
                    <option key={stage} value={stage}>
                      {label(stage)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Reason for stage change
                <input
                  maxLength={160}
                  value={reason}
                  required={Boolean(backward)}
                  disabled={Boolean(
                    selected && selected.project.stage === draft.stage,
                  )}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              {backward && (
                <p>
                  A reason is required when moving backward or restoring an
                  archived project.
                </p>
              )}
              <button
                className="button"
                disabled={
                  conflict ||
                  !draft.name.trim() ||
                  Boolean(backward && !reason.trim()) ||
                  (!selected && directory.totalCount >= directory.limit)
                }
              >
                Save private project
              </button>
              {selected?.project.stage === 'archived' && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={conflict}
                  onClick={() => setConfirmRemove(true)}
                >
                  Remove archived project
                </button>
              )}
              {confirmRemove && (
                <div role="group" aria-label="Confirm project removal">
                  <p>
                    Remove this archived project and its recent stage history?
                    Linked client and event records are retained.
                  </p>
                  <button
                    type="button"
                    className="button danger"
                    onClick={() => void remove()}
                  >
                    Confirm remove project
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => setConfirmRemove(false)}
                  >
                    Keep project
                  </button>
                </div>
              )}
            </fieldset>
            {conflict && (
              <p role="alert">
                Your draft is preserved. Load the latest projects before editing
                the current record.
              </p>
            )}
          </form>
          {selected && (
            <section aria-label="Project history">
              <h3>Recent stage history</h3>
              <p>
                {selected.project.transitions.length} of{' '}
                {selected.project.transitionCount} stage changes shown.
              </p>
              <ol>
                {[...selected.project.transitions].reverse().map((entry) => (
                  <li key={entry.sequence}>
                    {entry.from ? label(entry.from) : 'New project'} to{' '}
                    {label(entry.to)}.{' '}
                    <time dateTime={entry.at}>
                      {new Date(entry.at).toLocaleString()}
                    </time>
                    {entry.reason && <p>{entry.reason}</p>}
                  </li>
                ))}
              </ol>
              {selected.events.map((event) => (
                <p key={event.id}>
                  {event.title ? (
                    <Link to={`/app/events/${event.id}`}>
                      Open {event.title}
                    </Link>
                  ) : (
                    'A linked event is unavailable.'
                  )}
                </p>
              ))}
            </section>
          )}
        </div>
      </div>
    </section>
  );
}
