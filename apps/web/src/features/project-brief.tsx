import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, HttpError, saveFile, session } from '../api';
import { ErrorNote, Loading, PageTitle } from '../components/ui';
import {
  BRIEF_ACTOR,
  projectBrief,
  exportProjectBrief,
  type BriefNoteMode,
} from '../../../../packages/shared/src/project-brief';
import './project-brief.css';
import { exportNavigationGuard } from '../export-navigation';

export function ProjectProductionBrief() {
  const { projectId = '' } = useParams();
  const account = useQuery({
    queryKey: ['session'],
    queryFn: session,
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  if (account.isPending) return <Loading />;
  if (!account.data || account.error)
    return (
      <ErrorNote
        error={
          account.error ?? new Error('Sign in to review the production brief.')
        }
      />
    );
  return (
    <Brief
      key={`${account.data.id}:${projectId}`}
      accountId={account.data.id}
      projectId={projectId}
    />
  );
}
function Brief({
  accountId,
  projectId,
}: {
  accountId: string;
  projectId: string;
}) {
  const [notes, setNotes] = useState<BriefNoteMode>('omit'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [message, setMessage] = useState('');
  const cache = useQueryClient(),
    key = ['project-brief', accountId, projectId, notes];
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function read(signal: AbortSignal) {
    const data = projectBrief.parse(
      await api(`/studio/projects/${projectId}/brief?notes=${notes}`, {
        signal,
        headers: { [BRIEF_ACTOR]: accountId },
      }),
    );
    if (
      data.accountId !== accountId ||
      data.project.id !== projectId ||
      data.notes !== notes
    )
      throw new HttpError(
        403,
        'The production brief no longer matches this request.',
      );
    return data;
  }
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => read(signal),
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  async function download(format: 'text' | 'json') {
    if (busy || pending.current || query.isFetching || query.error) return;
    const controller = new AbortController();
    const assertActive = exportNavigationGuard(controller);
    pending.current = controller;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      const fresh = await read(controller.signal);
      assertActive();
      cache.setQueryData(key, fresh);
      const output = exportProjectBrief(fresh, format);
      saveFile(
        new Blob([output.content], { type: output.type }),
        output.filename,
      );
      setMessage(
        `Fresh ${format === 'text' ? 'text' : 'JSON'} brief downloaded. Private notes ${notes === 'include' ? 'included' : 'omitted'}.`,
      );
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (pending.current === controller) pending.current = null;
    }
  }
  const denied = [query.error, error].some(
    (v) => v instanceof HttpError && [401, 403, 404].includes(v.status),
  );
  if (denied) return <ErrorNote error={query.error ?? error} />;
  const value = !query.error ? query.data : undefined;
  return (
    <section className="production-brief stack">
      <PageTitle title="Project production brief" eyebrow="Private studio" />
      <p>
        Review linked events, milestones and appointments before a shoot or
        handoff. Downloads are local copies and do not invite anyone or confirm
        a booking.
      </p>
      <Link to="/app/projects" className="button secondary">
        Back to projects
      </Link>
      <ErrorNote error={query.error} />
      <ErrorNote error={error} />
      {message && <p role="status">{message}</p>}
      <fieldset disabled={busy} className="brief-actions">
        <legend>Brief disclosure and download</legend>
        <label>
          <input
            type="checkbox"
            checked={notes === 'include'}
            onChange={(event) => {
              setNotes(event.target.checked ? 'include' : 'omit');
              setError(null);
              setMessage('');
            }}
          />
          Include private project and work notes
        </label>
        <p>
          Client contact details, finances, photos and internal storage
          references are excluded in both modes. Review the content before
          sharing a downloaded copy.
        </p>
        <button
          type="button"
          className="button secondary"
          disabled={query.isFetching}
          onClick={() => {
            setError(null);
            setMessage('');
            void query.refetch();
          }}
        >
          Refresh production brief
        </button>
        <button
          type="button"
          className="button primary"
          disabled={!value || query.isFetching}
          onClick={() => void download('text')}
        >
          Download text brief
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={!value || query.isFetching}
          onClick={() => void download('json')}
        >
          Download JSON brief
        </button>
      </fieldset>
      {query.isPending && <Loading />}
      {value && (
        <section
          aria-label="Production brief preview"
          className="brief-preview stack"
        >
          <h2>{value.project.name}</h2>
          <p>
            Stage: {value.project.stage}. Private notes{' '}
            {value.notes === 'include' ? 'included' : 'omitted'}.
          </p>
          <p>
            Checked{' '}
            <time dateTime={value.checkedAt}>
              {new Date(value.checkedAt).toLocaleString()}
            </time>
            . Current project associations only.
          </p>
          {value.project.summary !== undefined && (
            <p className="brief-note">
              {value.project.summary || 'No project summary.'}
            </p>
          )}
          <h3>Linked events ({value.events.length})</h3>
          {!value.events.length && <p>No events linked.</p>}
          <ul>
            {value.events.map((row) => (
              <li key={row.id}>
                {row.title ? (
                  <Link to={`/app/events/${row.id}`}>{row.title}</Link>
                ) : (
                  'Unavailable linked event'
                )}
              </li>
            ))}
          </ul>
          <h3>Milestones ({value.milestones.length})</h3>
          {!value.milestones.length && <p>No milestones recorded.</p>}
          {value.milestones.map((row) => (
            <article className="glass-panel" key={row.id}>
              <h4>{row.title}</h4>
              <p>
                <time dateTime={row.dueDate}>{row.dueDate}</time> (
                {row.timeZone}). {row.status}.
              </p>
              {row.note !== undefined && (
                <p className="brief-note">{row.note || 'No milestone note.'}</p>
              )}
            </article>
          ))}
          <h3>Appointments ({value.appointments.length})</h3>
          {!value.appointments.length && <p>No appointments recorded.</p>}
          {value.appointments.map((row) => (
            <article className="glass-panel" key={row.id}>
              <h4>{row.title}</h4>
              <p>
                <time dateTime={row.startAt}>
                  {new Date(row.startAt).toLocaleString(undefined, {
                    timeZone: row.timeZone,
                  })}
                </time>{' '}
                to{' '}
                <time dateTime={row.endAt}>
                  {new Date(row.endAt).toLocaleString(undefined, {
                    timeZone: row.timeZone,
                  })}
                </time>{' '}
                ({row.timeZone}). {row.status}.
              </p>
              {row.note !== undefined && (
                <p className="brief-note">
                  {row.note || 'No appointment note.'}
                </p>
              )}
            </article>
          ))}
        </section>
      )}
    </section>
  );
}
