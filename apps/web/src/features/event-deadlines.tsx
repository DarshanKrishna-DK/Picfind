import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, HttpError, saveFile, session } from '../api';
import { ErrorNote, Loading, PageTitle } from '../components/ui';
import {
  DEADLINE_ACTOR,
  deadlineSnapshot,
  eventDeadlineState,
  filteredDeadlines,
  exportDeadlineCalendar,
  type DeadlineFilters,
  type CalendarAlarm,
} from '../../../../packages/shared/src/event-deadlines';
import './event-deadlines.css';

const labels = {
  soon: 'Within 7 days',
  active: 'More than 7 days left',
  expired: 'Expired',
  archived: 'Archived',
  undated: 'No explicit deadline',
};
export function EventDeadlines() {
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
        error={account.error ?? new Error('Sign in to review event deadlines.')}
      />
    );
  return <Planner key={account.data.id} accountId={account.data.id} />;
}
function Planner({ accountId }: { accountId: string }) {
  const cache = useQueryClient(),
    key = ['event-deadlines', accountId];
  async function read(signal: AbortSignal) {
    const result = deadlineSnapshot.parse(
      await api('/studio/event-deadlines', {
        signal,
        headers: { [DEADLINE_ACTOR]: accountId },
      }),
    );
    if (result.accountId !== accountId)
      throw new HttpError(403, 'These deadlines belong to another account.');
    return result;
  }
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => read(signal),
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  const [filters, setFilters] = useState<DeadlineFilters>({
      search: '',
      state: 'all',
    }),
    [alarm, setAlarm] = useState<CalendarAlarm>('none'),
    [shown, setShown] = useState(30),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  function filter(next: DeadlineFilters) {
    setFilters(next);
    setShown(30);
    setMessage('');
    setError(null);
  }
  async function refresh() {
    if (busy || query.isFetching) return;
    setMessage('');
    setError(null);
    await query.refetch();
  }
  async function download() {
    if (busy || query.isFetching || query.error || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      const current = await read(controller.signal);
      controller.signal.throwIfAborted();
      cache.setQueryData(key, current);
      const output = exportDeadlineCalendar(current, filters, alarm);
      controller.signal.throwIfAborted();
      saveFile(
        new Blob([output.content], { type: 'text/calendar;charset=utf-8' }),
        'picfind-event-access-deadlines.ics',
      );
      setMessage(
        `${output.count} calendar entries downloaded. Past alarm triggers omitted: ${output.alarmsOmitted}.`,
      );
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (pending.current === controller) pending.current = null;
    }
  }
  const denied = [query.error, error].some(
    (failure) =>
      failure instanceof HttpError && [401, 403].includes(failure.status),
  );
  if (denied) return <ErrorNote error={query.error ?? error} />;
  const snapshot = !query.error ? query.data : undefined;
  const rows = snapshot ? filteredDeadlines(snapshot, filters) : [];
  const future = snapshot
    ? rows.filter(
        (row) =>
          row.expiresAt &&
          !row.archived &&
          Date.parse(row.expiresAt) > Date.parse(snapshot.checkedAt),
      ).length
    : 0;
  return (
    <section className="deadline-planner stack">
      <PageTitle title="Event access planner" eyebrow="Private studio" />
      <p>
        Review access deadlines across your own events. These dates do not
        guarantee when stored files are physically deleted.
      </p>
      <ErrorNote error={query.error} />
      <ErrorNote error={error} />
      {message && <p role="status">{message}</p>}
      <button
        type="button"
        className="button secondary"
        disabled={busy || query.isFetching}
        onClick={() => void refresh()}
      >
        Refresh event deadlines
      </button>
      {query.isPending && <Loading />}
      {snapshot && (
        <>
          <p>
            Status as of{' '}
            <time dateTime={snapshot.checkedAt}>
              {new Date(snapshot.checkedAt).toLocaleString()}
            </time>
            . Refresh after changing an event.
          </p>
          <fieldset disabled={busy} className="deadline-controls">
            <legend>Planner filters and calendar copy</legend>
            <label>
              Find event
              <input
                type="search"
                maxLength={200}
                value={filters.search}
                onChange={(event) =>
                  filter({ ...filters, search: event.target.value })
                }
              />
            </label>
            <label>
              Deadline state
              <select
                value={filters.state}
                onChange={(event) =>
                  filter({
                    ...filters,
                    state: event.target.value as DeadlineFilters['state'],
                  })
                }
              >
                <option value="all">All states</option>
                {Object.entries(labels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Calendar alarm
              <select
                value={alarm}
                onChange={(event) => {
                  setAlarm(event.target.value as CalendarAlarm);
                  setMessage('');
                }}
              >
                <option value="none">No alarm</option>
                <option value="day">One day before</option>
                <option value="week">Seven days before</option>
              </select>
            </label>
            <button
              type="button"
              className="button primary"
              disabled={future === 0 || query.isFetching}
              onClick={() => void download()}
            >
              Download future deadlines
            </button>
          </fieldset>
          <p>
            The calendar includes matching future active deadlines only. Import
            the file into your calendar and review its alarm settings. PicFind
            does not send these reminders or update imported copies. Past alarm
            triggers are omitted.
          </p>
          <p>
            {rows.length} matching events. {future} future active deadlines
            available for export.
          </p>
          {!rows.length && <p>No events match these filters.</p>}
          <section className="deadline-list" aria-label="Owned event deadlines">
            {rows.slice(0, shown).map((row) => (
              <article className="glass-panel" key={row.id}>
                <div>
                  <h2>{row.title}</h2>
                  <p>{labels[eventDeadlineState(row, snapshot.checkedAt)]}</p>
                </div>
                <p>
                  {row.expiresAt ? (
                    <>
                      <span>Access deadline: </span>
                      <time dateTime={row.expiresAt}>
                        {new Date(row.expiresAt).toLocaleString()}
                      </time>
                    </>
                  ) : (
                    'No explicit event access deadline recorded.'
                  )}
                </p>
                <Link className="button secondary" to={`/app/events/${row.id}`}>
                  Review {row.title}
                </Link>
              </article>
            ))}
          </section>
          {rows.length > shown && (
            <button
              type="button"
              className="button secondary"
              onClick={() => setShown(shown + 30)}
            >
              Show more event deadlines
            </button>
          )}
        </>
      )}
    </section>
  );
}
