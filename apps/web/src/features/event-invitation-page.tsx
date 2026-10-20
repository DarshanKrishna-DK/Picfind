import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { api, HttpError, session } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import {
  blankInvitationPage,
  invitationPageCommand,
  invitationPageSnapshot,
  publicInvitationPage,
  type InvitationPageFields,
  type InvitationPageSnapshot,
} from '../../../../packages/shared/src/event-invitation-page';
import './event-invitation-page.css';
import { InvitationCalendar } from './invitation-calendar';
import { GuestRsvp } from './guest-rsvp';

const headers = (accountId: string) => ({
  'X-PicFind-Invitation-Actor': accountId,
});
function parseSnapshot(value: unknown, accountId: string, eventId: string) {
  const result = invitationPageSnapshot.parse(value);
  if (result.accountId !== accountId || result.eventId !== eventId)
    throw new HttpError(
      403,
      'Your signed-in account or event changed. Reload the event.',
    );
  return result;
}
async function read(eventId: string, accountId: string, signal: AbortSignal) {
  return parseSnapshot(
    await api(`/events/${eventId}/invitation-page`, {
      headers: headers(accountId),
      signal,
    }),
    accountId,
    eventId,
  );
}
export function EventInvitationEditor({ eventId }: { eventId: string }) {
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
          account.error ?? new Error('Sign in to edit invitation details.')
        }
      />
    );
  return (
    <InvitationLoader
      key={`${account.data.id}:${eventId}`}
      accountId={account.data.id}
      eventId={eventId}
    />
  );
}
function InvitationLoader({
  accountId,
  eventId,
}: {
  accountId: string;
  eventId: string;
}) {
  const query = useQuery({
    queryKey: ['invitation-editor', accountId, eventId],
    queryFn: ({ signal }) => read(eventId, accountId, signal),
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  if (query.isPending) return <Loading />;
  if (query.error)
    return (
      <section className="settings-panel">
        <h2>Invitation details</h2>
        <ErrorNote error={query.error} />
        <button
          type="button"
          className="button"
          onClick={() => void query.refetch()}
        >
          Retry invitation details
        </button>
      </section>
    );
  return <InvitationEditor initial={query.data} />;
}
function InvitationEditor({ initial }: { initial: InvitationPageSnapshot }) {
  const [saved, setSaved] = useState(initial),
    [draft, setDraft] = useState(initial.page.draft);
  const [busy, setBusy] = useState(false),
    [denied, setDenied] = useState(false),
    [conflict, setConflict] = useState(false);
  const [error, setError] = useState<unknown>(null),
    [message, setMessage] = useState('');
  const [confirmPublish, setConfirmPublish] = useState(false),
    [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved.page.draft);
  const unpublishedChanges =
    !!saved.page.published &&
    JSON.stringify(saved.page.draft) !==
      JSON.stringify(saved.page.published.fields);
  const valid = (action: 'save' | 'publish') =>
    invitationPageCommand.safeParse({
      action,
      version: saved.page.version,
      fields: draft,
    }).success;
  function change<K extends keyof InvitationPageFields>(
    key: K,
    value: InvitationPageFields[K],
  ) {
    setDraft({ ...draft, [key]: value });
    setConfirmPublish(false);
    setConfirmWithdraw(false);
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
      if (
        failure instanceof HttpError &&
        failure.code === 'INVITATION_PAGE_CHANGED'
      )
        setConflict(true);
      if (
        failure instanceof HttpError &&
        [401, 403, 404].includes(failure.status)
      ) {
        setDenied(true);
        setDraft(blankInvitationPage());
        setSaved({
          ...initial,
          editable: false,
          page: {
            draft: blankInvitationPage(),
            published: null,
            version: 0,
            updatedAt: null,
          },
        });
        setConfirmPublish(false);
        setConfirmWithdraw(false);
      }
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function reload() {
    if (
      dirty &&
      !window.confirm('Discard unsaved invitation details and reload?')
    )
      return;
    await run(async (signal) => {
      const latest = await read(initial.eventId, initial.accountId, signal);
      signal.throwIfAborted();
      setSaved(latest);
      setDraft(latest.page.draft);
      setConflict(false);
      setDenied(false);
      setConfirmPublish(false);
      setConfirmWithdraw(false);
      setMessage('Latest saved invitation details loaded.');
    });
  }
  async function submit(action: 'save' | 'publish' | 'withdraw') {
    if (
      conflict ||
      denied ||
      (action === 'publish' && !confirmPublish) ||
      (action === 'withdraw' && !confirmWithdraw)
    )
      return;
    await run(async (signal) => {
      const command = invitationPageCommand.parse({
        version: saved.page.version,
        action,
        fields: action === 'withdraw' ? saved.page.draft : draft,
      });
      const latest = parseSnapshot(
        await api(`/events/${initial.eventId}/invitation-page`, {
          method: 'PUT',
          headers: headers(initial.accountId),
          signal,
          body: JSON.stringify(command),
        }),
        initial.accountId,
        initial.eventId,
      );
      signal.throwIfAborted();
      setSaved(latest);
      if (action !== 'withdraw') setDraft(latest.page.draft);
      setConfirmPublish(false);
      setConfirmWithdraw(false);
      setMessage(
        action === 'publish'
          ? 'Invitation published. Anyone with its link can read these details.'
          : action === 'withdraw'
            ? 'Invitation withdrawn. Unsaved editor changes were preserved.'
            : 'Private invitation draft saved. Published details were not changed.',
      );
    });
  }
  if (denied)
    return (
      <section className="settings-panel">
        <h2>Invitation details unavailable</h2>
        <ErrorNote error={error} />
        <p>Private editor details have been hidden because access changed.</p>
      </section>
    );
  return (
    <section className="invitation-editor settings-panel">
      <h2>Invitation details</h2>
      <p>
        Prepare practical event information, then explicitly publish a page for
        anyone with its link. This does not change gallery access.
      </p>
      <p role="status">
        {saved.page.published
          ? `Published revision ${saved.page.published.revision}.`
          : 'No invitation page is published.'}{' '}
        {unpublishedChanges
          ? 'Your saved draft differs from the published page.'
          : ''}{' '}
        {dirty ? 'You have unsaved invitation changes.' : ''}
      </p>
      {!saved.editable && (
        <p role="status">
          This event is closed. Details are read-only, and its invitation is
          unavailable. You can still withdraw the publication.
        </p>
      )}
      {conflict && (
        <p role="alert">
          Your draft is preserved. Reload the current invitation before saving
          again.
        </p>
      )}
      <ErrorNote error={error} />
      {message && <p role="status">{message}</p>}
      <div className="invitation-editor-grid">
        <div>
          {!valid('save') && (
            <p role="alert">
              Use a heading, a valid timezone and dates from 2000 through 2100.
              If a time is entered, it must exist on that date in the selected
              timezone.
            </p>
          )}
          <fieldset disabled={busy || conflict || !saved.editable}>
            <legend>Invitation content</legend>
            <label>
              Invitation heading
              <input
                value={draft.heading}
                maxLength={120}
                onChange={(e) => change('heading', e.target.value)}
              />
            </label>
            <label>
              Host display name
              <input
                value={draft.host}
                maxLength={100}
                onChange={(e) => change('host', e.target.value)}
              />
            </label>
            <label>
              Invitation date
              <input
                type="date"
                min="2000-01-01"
                max="2100-12-31"
                value={draft.date}
                onChange={(e) => change('date', e.target.value)}
              />
            </label>
            <label>
              Invitation local time (optional)
              <input
                type="time"
                value={draft.time}
                onChange={(e) => change('time', e.target.value)}
              />
            </label>
            <label>
              Invitation timezone
              <input
                value={draft.timeZone}
                maxLength={100}
                onChange={(e) => change('timeZone', e.target.value)}
              />
            </label>
            <p>
              Use an IANA timezone such as Asia/Kolkata. A local time must exist
              in that timezone. Omit the time when it is not decided.
            </p>
            <label>
              Venue name
              <input
                value={draft.venue}
                maxLength={150}
                onChange={(e) => change('venue', e.target.value)}
              />
            </label>
            <label>
              Venue address
              <textarea
                value={draft.address}
                maxLength={300}
                rows={3}
                onChange={(e) => change('address', e.target.value)}
              />
            </label>
            <label>
              Guest instructions
              <textarea
                value={draft.instructions}
                maxLength={1000}
                rows={5}
                onChange={(e) => change('instructions', e.target.value)}
              />
            </label>
            <label>
              Invitation theme
              <select
                value={draft.theme}
                onChange={(e) =>
                  change(
                    'theme',
                    e.target.value as InvitationPageFields['theme'],
                  )
                }
              >
                <option value="linen">Linen</option>
                <option value="forest">Forest</option>
                <option value="midnight">Midnight</option>
              </select>
            </label>
          </fieldset>
          <div className="invitation-actions">
            <button
              type="button"
              className="button"
              disabled={
                busy || conflict || !saved.editable || !valid('save') || !dirty
              }
              onClick={() => void submit('save')}
            >
              Save private invitation draft
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => void reload()}
            >
              Reload invitation details
            </button>
          </div>
          <div className="invitation-publication">
            <h3>Publish explicitly</h3>
            {!draft.date && <p>Choose an invitation date before publishing.</p>}
            <p>
              Publication exposes the heading, host name, date, time, venue,
              address and instructions entered above. Only include information
              you intend to share with anyone holding the link.
            </p>
            <label className="invitation-check">
              <input
                type="checkbox"
                checked={confirmPublish}
                disabled={busy || conflict || !saved.editable}
                onChange={(e) => setConfirmPublish(e.target.checked)}
              />
              I confirm these invitation details can be public.
            </label>
            <button
              type="button"
              className="button"
              disabled={
                busy ||
                conflict ||
                !saved.editable ||
                !confirmPublish ||
                !valid('publish')
              }
              onClick={() => void submit('publish')}
            >
              Publish current invitation
            </button>
            {saved.page.published && (
              <>
                <Link to={`/invite/${encodeURIComponent(initial.eventId)}`}>
                  Open published invitation
                </Link>
                <label>
                  Published invitation link
                  <input
                    readOnly
                    value={`${window.location.origin}/invite/${encodeURIComponent(initial.eventId)}`}
                  />
                </label>
                <p>
                  Withdrawal blocks future page reads. Information already
                  viewed or copied cannot be recalled.
                </p>
                <label className="invitation-check">
                  <input
                    type="checkbox"
                    checked={confirmWithdraw}
                    disabled={busy || conflict}
                    onChange={(e) => setConfirmWithdraw(e.target.checked)}
                  />
                  Confirm withdrawal of the invitation page
                </label>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy || conflict || !confirmWithdraw}
                  onClick={() => void submit('withdraw')}
                >
                  Withdraw invitation
                </button>
              </>
            )}
          </div>
        </div>
        <div className="invitation-preview">
          <h3>Local preview</h3>
          <p>
            This preview includes unsaved edits. It is not the published page.
          </p>
          <InvitationCard fields={draft} preview />
        </div>
      </div>
    </section>
  );
}
function InvitationCard({
  fields,
  preview = false,
}: {
  fields: InvitationPageFields;
  preview?: boolean;
}) {
  return (
    <article
      className={`invitation-card invitation-${fields.theme}`}
      aria-label={preview ? 'Local invitation preview' : 'Published invitation'}
    >
      <p className="invitation-eyebrow">You are invited</p>
      {preview ? (
        <h4>{fields.heading || 'Invitation heading'}</h4>
      ) : (
        <h1>{fields.heading}</h1>
      )}
      {fields.host && (
        <p className="invitation-host">Hosted by {fields.host}</p>
      )}
      <dl>
        {fields.date && (
          <>
            <dt>Date</dt>
            <dd>{fields.date}</dd>
          </>
        )}
        {fields.time && (
          <>
            <dt>Local time</dt>
            <dd>
              {fields.time} ({fields.timeZone})
            </dd>
          </>
        )}
        {fields.venue && (
          <>
            <dt>Venue</dt>
            <dd>{fields.venue}</dd>
          </>
        )}
        {fields.address && (
          <>
            <dt>Address</dt>
            <dd>{fields.address}</dd>
          </>
        )}
      </dl>
      {fields.instructions && (
        <div className="invitation-instructions">
          <p>Guest instructions</p>
          <p>{fields.instructions}</p>
        </div>
      )}
      <p className="invitation-footer">Shared with PicFind</p>
    </article>
  );
}
export function PublishedInvitationPage() {
  const { eventId = '' } = useParams();
  const query = useQuery({
    queryKey: ['published-invitation', eventId],
    queryFn: async ({ signal }) => {
      const page = publicInvitationPage.parse(
        await api(`/public/invitations/${encodeURIComponent(eventId)}`, {
          signal,
        }),
      );
      if (page.eventId !== eventId)
        throw new Error('This invitation response belongs to another event.');
      return page;
    },
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: 'always',
    refetchInterval: 30_000,
  });
  return (
    <section className="wrap standalone invitation-public">
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <>
          <h1>This invitation is unavailable.</h1>
          <ErrorNote error={query.error} />
          <button
            type="button"
            className="button"
            onClick={() => void query.refetch()}
          >
            Retry invitation
          </button>
        </>
      ) : (
        <>
          <InvitationCard fields={query.data.fields} />
          <InvitationCalendar
            key={`${eventId}:${query.data.revision}`}
            page={query.data}
          />
          <GuestRsvp eventId={eventId} seenRevision={query.data.revision} />
          <p className="invitation-refresh">
            Details can change. This page refreshes periodically while open.
          </p>
        </>
      )}
    </section>
  );
}
