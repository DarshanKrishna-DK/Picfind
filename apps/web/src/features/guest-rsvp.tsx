import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { api, HttpError } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import {
  guestRsvpSnapshot,
  rsvpFields,
  RSVP_CONSENT,
  type GuestRsvpSnapshot,
  type RsvpFields,
} from '../../../../packages/shared/src/event-rsvp';
import './event-rsvp.css';

const blank = (): RsvpFields => ({
  displayName: '',
  response: 'going',
  partySize: 1,
  message: '',
});
function fieldsOf(snapshot: GuestRsvpSnapshot): RsvpFields {
  const value = snapshot.response;
  return value
    ? {
        displayName: value.displayName,
        response: value.response,
        partySize: value.partySize,
        message: value.message,
      }
    : blank();
}
function parse(value: unknown, eventId: string) {
  const data = guestRsvpSnapshot.parse(value);
  if (data.eventId !== eventId)
    throw new HttpError(403, 'This response belongs to another event.');
  return data;
}
export function GuestRsvp({
  eventId,
  seenRevision,
  management = false,
}: {
  eventId: string;
  seenRevision?: number;
  management?: boolean;
}) {
  const client = useQueryClient(),
    queryKey = ['guest-rsvp', eventId];
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) =>
      parse(
        await api(`/public/invitations/${eventId}/rsvp`, { signal }),
        eventId,
      ),
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  if (query.isPending) return <Loading />;
  if (query.error)
    return (
      <section className="rsvp-panel">
        <h2>Your event response is unavailable</h2>
        <ErrorNote error={query.error} />
        <button
          type="button"
          className="button"
          onClick={() => void query.refetch()}
        >
          Retry response
        </button>
      </section>
    );
  if (!management && !query.data.policy.enabled && !query.data.response)
    return null;
  return (
    <GuestEditor
      key={`${eventId}:${query.data.receiptId ?? 'new'}`}
      initial={query.data}
      live={query.data}
      seenRevision={seenRevision}
      onSnapshot={(value) => client.setQueryData(queryKey, value)}
    />
  );
}
function GuestEditor({
  initial,
  live,
  seenRevision,
  onSnapshot,
}: {
  initial: GuestRsvpSnapshot;
  live: GuestRsvpSnapshot;
  seenRevision: number | undefined;
  onSnapshot: (value: GuestRsvpSnapshot) => void;
}) {
  const [saved, setSaved] = useState(initial),
    [draft, setDraft] = useState(() => fieldsOf(initial));
  const [consent, setConsent] = useState(false),
    [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false),
    [conflict, setConflict] = useState(false),
    [denied, setDenied] = useState(false);
  const [error, setError] = useState<unknown>(null),
    [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const newer =
    (live.response?.version ?? 0) !== (saved.response?.version ?? 0);
  const invitationChanged =
    seenRevision !== undefined && seenRevision !== live.invitationRevision;
  const dirty = JSON.stringify(draft) !== JSON.stringify(fieldsOf(saved));
  const valid =
    rsvpFields.safeParse(draft).success &&
    draft.partySize <= live.policy.maxPartySize;
  const locked = busy || conflict || newer || denied;
  function change<K extends keyof RsvpFields>(key: K, value: RsvpFields[K]) {
    setDraft({
      ...draft,
      [key]: value,
      ...(key === 'response'
        ? {
            partySize: value === 'not-going' ? 0 : Math.max(1, draft.partySize),
          }
        : {}),
    });
    setConsent(false);
    setConfirmRemove(false);
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
      if (failure instanceof HttpError && failure.status === 409)
        setConflict(true);
      if (
        failure instanceof HttpError &&
        [401, 403, 404].includes(failure.status)
      ) {
        setDenied(true);
        setDraft(blank());
        setConsent(false);
        setConfirmRemove(false);
      }
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  function accept(value: unknown) {
    const snapshot = parse(value, initial.eventId);
    if (saved.receiptId && snapshot.receiptId !== saved.receiptId)
      throw new HttpError(
        403,
        'Your browser response receipt changed. Reload this page.',
      );
    setSaved(snapshot);
    onSnapshot(snapshot);
    return snapshot;
  }
  async function start() {
    await run(async (signal) => {
      const snapshot = parse(
        await api(`/public/invitations/${initial.eventId}/rsvp/session`, {
          method: 'POST',
          body: '{}',
          signal,
        }),
        initial.eventId,
      );
      signal.throwIfAborted();
      onSnapshot(snapshot);
    });
  }
  async function reload() {
    if (
      dirty &&
      !window.confirm('Discard unsaved response changes and reload?')
    )
      return;
    await run(async (signal) => {
      const value = await api(`/public/invitations/${initial.eventId}/rsvp`, {
        signal,
      });
      signal.throwIfAborted();
      const snapshot = accept(value);
      setDraft(fieldsOf(snapshot));
      setConflict(false);
      setConsent(false);
      setConfirmRemove(false);
      setMessage('Latest response loaded.');
    });
  }
  async function save() {
    if (locked || !consent || !valid || !live.accepting || invitationChanged)
      return;
    await run(async (signal) => {
      const value = await api(`/public/invitations/${initial.eventId}/rsvp`, {
        method: 'PUT',
        signal,
        body: JSON.stringify({
          ...draft,
          version: saved.response?.version ?? 0,
          receiptId: saved.receiptId,
          invitationRevision: live.invitationRevision,
          consent: RSVP_CONSENT,
        }),
      });
      signal.throwIfAborted();
      const snapshot = accept(value);
      setDraft(fieldsOf(snapshot));
      setConsent(false);
      setConfirmRemove(false);
      setMessage('Your response was saved privately for the event host.');
    });
  }
  async function withdraw() {
    if (locked || !confirmRemove || !saved.response) return;
    await run(async (signal) => {
      await api(`/public/invitations/${initial.eventId}/rsvp`, {
        method: 'DELETE',
        signal,
        body: JSON.stringify({
          receiptId: saved.receiptId,
          version: saved.response!.version,
        }),
      });
      signal.throwIfAborted();
      setSaved({ ...saved, response: null });
      setDraft(blank());
      setConsent(false);
      setConfirmRemove(false);
      setMessage(
        'Your response was withdrawn and this browser receipt was cleared.',
      );
      // Keep the confirmation visible until a deliberate reload or route change.
      setDenied(true);
    });
  }
  if (denied)
    return (
      <section className="rsvp-panel">
        <h2>Your event response</h2>
        <ErrorNote error={error} />
        <p role="status">
          {message ||
            'Response details are hidden because access changed. Reload this page to check your browser receipt.'}
        </p>
      </section>
    );
  return (
    <section className="rsvp-panel" aria-label="Your event response">
      <h2>Your event response</h2>
      <p>
        Tell the host your plans. This is an attendance intention, not an
        admission ticket or confirmed place.
      </p>
      <p>
        Your name, response, reported party size and message are shared
        privately with the event host. No email, phone, selfie or account is
        required.
      </p>
      <p>
        This browser keeps a response receipt for up to 30 days. Use the same
        browser to edit or withdraw. Clearing cookies or changing browsers loses
        access and may create another response.
      </p>
      {live.policy.closesAt && (
        <p>Responses close at {live.policy.closesAt} (UTC).</p>
      )}
      {!live.accepting && (
        <p role="status">
          This event is not accepting new or changed responses. You can still
          withdraw a saved response from this browser.
        </p>
      )}
      {(conflict || newer) && (
        <p role="alert">
          Saved details changed. Your draft is preserved. Reload before
          submitting again.
        </p>
      )}
      {invitationChanged && (
        <p role="alert">
          The invitation changed. Refresh the invitation page and review its
          latest details before responding.
        </p>
      )}
      <ErrorNote error={error} />
      {message && <p role="status">{message}</p>}
      {!saved.receiptId ? (
        <button
          type="button"
          className="button"
          disabled={busy || !live.accepting || invitationChanged}
          onClick={() => void start()}
        >
          Start my response on this browser
        </button>
      ) : (
        <>
          {saved.response && (
            <p role="status">
              Saved response: {saved.response.response}. Reported party size:{' '}
              {saved.response.partySize}. Last updated{' '}
              {saved.response.updatedAt}.
            </p>
          )}
          <fieldset disabled={locked || !live.accepting || invitationChanged}>
            <legend>Response details</legend>
            <label>
              Your display name
              <input
                value={draft.displayName}
                maxLength={100}
                onChange={(e) => change('displayName', e.target.value)}
              />
            </label>
            <label>
              Your attendance intention
              <select
                value={draft.response}
                onChange={(e) =>
                  change('response', e.target.value as RsvpFields['response'])
                }
              >
                <option value="going">Going</option>
                <option value="maybe">Maybe</option>
                <option value="not-going">Not going</option>
              </select>
            </label>
            <label>
              Reported party size
              <input
                type="number"
                min={draft.response === 'not-going' ? 0 : 1}
                max={live.policy.maxPartySize}
                value={draft.partySize}
                disabled={draft.response === 'not-going'}
                onChange={(e) => change('partySize', Number(e.target.value))}
              />
            </label>
            <label>
              Private message to host (optional)
              <textarea
                rows={3}
                maxLength={300}
                value={draft.message}
                onChange={(e) => change('message', e.target.value)}
              />
            </label>
            <p>
              The host permits up to {live.policy.maxPartySize} people per
              response. Avoid sensitive personal details in the message.
            </p>
            <label className="rsvp-check">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              I have reviewed the invitation and agree to share these response
              details with the host.
            </label>
            <button
              type="button"
              className="button"
              disabled={!consent || !valid}
              onClick={() => void save()}
            >
              Save my response
            </button>
          </fieldset>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => void reload()}
          >
            Reload my response
          </button>
          <Link to={`/invite/${initial.eventId}/response`}>
            Manage this browser response
          </Link>
          <Link to={`/invite/${initial.eventId}`}>View event invitation</Link>
          {saved.response && (
            <div className="rsvp-removal">
              <label className="rsvp-check">
                <input
                  type="checkbox"
                  checked={confirmRemove}
                  disabled={locked}
                  onChange={(e) => setConfirmRemove(e.target.checked)}
                />
                Confirm withdrawal of my saved response
              </label>
              <button
                type="button"
                className="button secondary"
                disabled={locked || !confirmRemove}
                onClick={() => void withdraw()}
              >
                Withdraw my response
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
export function GuestRsvpPage() {
  const { eventId = '' } = useParams();
  return (
    <section className="wrap standalone">
      <h1>Manage your event response</h1>
      <GuestRsvp eventId={eventId} management />
    </section>
  );
}
