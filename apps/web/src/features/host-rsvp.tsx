import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, HttpError, session } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import {
  hostRsvpSnapshot,
  rsvpSettingsWrite,
  rsvpTotals,
  type HostRsvpSnapshot,
  type RsvpView,
} from '../../../../packages/shared/src/event-rsvp';
import './event-rsvp.css';

const headers = (accountId: string) => ({ 'X-PicFind-Rsvp-Actor': accountId });
function parse(value: unknown, eventId: string, accountId: string) {
  const result = hostRsvpSnapshot.parse(value);
  if (result.accountId !== accountId || result.eventId !== eventId)
    throw new HttpError(
      403,
      'Your account or event changed. Reload responses.',
    );
  return result;
}
async function read(eventId: string, accountId: string, signal: AbortSignal) {
  return parse(
    await api(`/events/${eventId}/rsvp`, {
      signal,
      headers: headers(accountId),
    }),
    eventId,
    accountId,
  );
}
export function HostRsvp({ eventId }: { eventId: string }) {
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
        error={account.error ?? new Error('Sign in to manage event responses.')}
      />
    );
  return (
    <HostLoader
      key={`${account.data.id}:${eventId}`}
      eventId={eventId}
      accountId={account.data.id}
    />
  );
}
function HostLoader({
  eventId,
  accountId,
}: {
  eventId: string;
  accountId: string;
}) {
  const query = useQuery({
    queryKey: ['host-rsvp', accountId, eventId],
    queryFn: ({ signal }) => read(eventId, accountId, signal),
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  if (query.isPending) return <Loading />;
  if (query.error)
    return (
      <section className="rsvp-panel">
        <h2>Private event responses</h2>
        <ErrorNote error={query.error} />
        <button
          type="button"
          className="button"
          onClick={() => void query.refetch()}
        >
          Retry event responses
        </button>
      </section>
    );
  return <HostEditor initial={query.data} />;
}
function HostEditor({ initial }: { initial: HostRsvpSnapshot }) {
  const [saved, setSaved] = useState(initial),
    [enabled, setEnabled] = useState(initial.settings.enabled);
  const [closing, setClosing] = useState(
      initial.settings.closesAt?.replace(/Z$/, '') ?? '',
    ),
    [partyLimit, setPartyLimit] = useState(initial.settings.maxPartySize);
  const [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all'),
    [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false),
    [conflict, setConflict] = useState(false),
    [message, setMessage] = useState('');
  const [error, setError] = useState<unknown>(null),
    [removing, setRemoving] = useState<RsvpView | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const closesAt = closing
    ? Number.isFinite(Date.parse(`${closing}Z`))
      ? new Date(`${closing}Z`).toISOString()
      : closing
    : null;
  const fields = { enabled, closesAt, maxPartySize: partyLimit },
    dirty =
      enabled !== saved.settings.enabled ||
      closesAt !== saved.settings.closesAt ||
      partyLimit !== saved.settings.maxPartySize;
  const valid = rsvpSettingsWrite.safeParse({
    ...fields,
    version: saved.settings.version,
  }).success;
  const totals = rsvpTotals(saved.responses),
    visible = saved.responses.filter(
      (row) =>
        (filter === 'all' || row.response === filter) &&
        `${row.displayName} ${row.message}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
    );
  function adopt(value: HostRsvpSnapshot, discard: boolean) {
    setSaved(value);
    setRemoving(null);
    if (discard) {
      setEnabled(value.settings.enabled);
      setClosing(value.settings.closesAt?.replace(/Z$/, '') ?? '');
      setPartyLimit(value.settings.maxPartySize);
      setConflict(false);
    } else if (value.settings.version !== saved.settings.version)
      setConflict(true);
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
      if (failure instanceof HttpError && failure.status === 409)
        setConflict(true);
      if (
        failure instanceof HttpError &&
        [401, 403, 404].includes(failure.status)
      ) {
        setDenied(true);
        setSaved({ ...initial, responses: [] });
        setRemoving(null);
      }
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function reload() {
    if (
      dirty &&
      !window.confirm('Discard unsaved response settings and reload?')
    )
      return;
    await run(async (signal) => {
      const value = await read(initial.eventId, initial.accountId, signal);
      signal.throwIfAborted();
      adopt(value, true);
      setMessage('Latest response settings and saved responses loaded.');
    });
  }
  async function save() {
    if (conflict || !valid) return;
    await run(async (signal) => {
      const result = await api(`/events/${initial.eventId}/rsvp`, {
        method: 'PUT',
        signal,
        headers: headers(initial.accountId),
        body: JSON.stringify({ ...fields, version: saved.settings.version }),
      });
      signal.throwIfAborted();
      adopt(parse(result, initial.eventId, initial.accountId), true);
      setMessage('Response collection settings saved.');
    });
  }
  async function remove() {
    if (!removing) return;
    const target = removing;
    await run(async (signal) => {
      await api(`/events/${initial.eventId}/rsvp/${target.id}`, {
        method: 'DELETE',
        signal,
        headers: headers(initial.accountId),
        body: JSON.stringify({ version: target.version }),
      });
      signal.throwIfAborted();
      const value = await read(initial.eventId, initial.accountId, signal);
      signal.throwIfAborted();
      adopt(value, false);
      setMessage(
        'The selected response was removed. This does not ban the guest from responding again while collection is open.',
      );
    });
  }
  if (denied)
    return (
      <section className="rsvp-panel">
        <h2>Private responses unavailable</h2>
        <ErrorNote error={error} />
        <p>Response details are hidden because access changed.</p>
      </section>
    );
  return (
    <section className="rsvp-panel" aria-label="Private event responses">
      <h2>Private event responses</h2>
      <p>
        Collect attendance intentions from the published invitation. Guest names
        and messages stay private to you. Counts are submitted responses and
        reported party sizes, not verified people or attendance.
      </p>
      <p role="status">
        {saved.accepting
          ? 'Currently accepting responses.'
          : 'Currently not accepting responses.'}{' '}
        An active event, published invitation, enabled collection and open
        deadline are all required.
      </p>
      {!saved.editable && (
        <p>
          This event is closed. You can turn collection off and remove retained
          responses.
        </p>
      )}
      {conflict && (
        <p role="alert">
          Saved details changed. Your settings draft is preserved. Reload before
          saving again.
        </p>
      )}
      <ErrorNote error={error} />
      {message && <p role="status">{message}</p>}
      <fieldset disabled={busy || conflict}>
        <legend>Response collection settings</legend>
        <label className="rsvp-check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Enable RSVP collection on the published invitation
        </label>
        <label>
          Responses close (UTC, optional)
          <input
            type="datetime-local"
            step="0.001"
            value={closing}
            onChange={(e) => setClosing(e.target.value)}
          />
        </label>
        <label>
          Maximum reported party size
          <input
            type="number"
            min={1}
            max={10}
            value={partyLimit}
            onChange={(e) => setPartyLimit(Number(e.target.value))}
          />
        </label>
        <p>
          Leave the closing time empty to accept responses until collection or
          the invitation closes. Reducing the party limit does not rewrite
          existing responses.
        </p>
        <button
          type="button"
          className="button"
          disabled={!valid || !dirty || (!saved.editable && enabled)}
          onClick={() => void save()}
        >
          Save response settings
        </button>
      </fieldset>
      <button
        type="button"
        className="button secondary"
        disabled={busy}
        onClick={() => void reload()}
      >
        Reload event responses
      </button>
      <dl className="rsvp-totals" aria-label="All saved response totals">
        <div>
          <dt>Saved responses</dt>
          <dd>
            {totals.responses} / {saved.limit}
          </dd>
        </div>
        <div>
          <dt>Going responses</dt>
          <dd>{totals.going}</dd>
        </div>
        <div>
          <dt>Reported going party total</dt>
          <dd>{totals.goingParty}</dd>
        </div>
        <div>
          <dt>Maybe responses</dt>
          <dd>{totals.maybe}</dd>
        </div>
        <div>
          <dt>Reported maybe party total</dt>
          <dd>{totals.maybeParty}</dd>
        </div>
        <div>
          <dt>Not-going responses</dt>
          <dd>{totals.notGoing}</dd>
        </div>
      </dl>
      <label>
        Search private responses
        <input
          value={search}
          maxLength={1000}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <label>
        Response filter
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All responses</option>
          <option value="going">Going</option>
          <option value="maybe">Maybe</option>
          <option value="not-going">Not going</option>
        </select>
      </label>
      <p>
        {visible.length} matching responses. Totals above include every saved
        response.
      </p>
      {removing && (
        <div
          className="rsvp-removal"
          role="group"
          aria-label="Confirm response removal"
        >
          <p>
            Remove the saved response from {removing.displayName}? This removes
            its name, message and reported party size.
          </p>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => void remove()}
          >
            Confirm remove response
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => setRemoving(null)}
          >
            Keep response
          </button>
        </div>
      )}
      <ul className="rsvp-list" aria-label="Saved private responses">
        {visible.map((row) => (
          <li key={row.id}>
            <h3>{row.displayName}</h3>
            <p>
              {row.response}. Reported party size: {row.partySize}.
            </p>
            {row.message && <p className="rsvp-message">{row.message}</p>}
            <p>Updated {row.updatedAt}</p>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => setRemoving(row)}
            >
              Remove response from {row.displayName}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
