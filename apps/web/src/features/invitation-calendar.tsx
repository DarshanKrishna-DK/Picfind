import { useEffect, useRef, useState } from 'react';
import { api, saveFile } from '../api';
import { ErrorNote } from '../components/ui';
import {
  publicInvitationPage,
  type PublicInvitationPage,
} from '../../../../packages/shared/src/event-invitation-page';
import {
  exportInvitationCalendar,
  invitationInstants,
} from '../../../../packages/shared/src/invitation-calendar';

export function InvitationCalendar({ page }: { page: PublicInvitationPage }) {
  const [chosen, setChosen] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const instants = invitationInstants(page),
    instant = instants.length === 1 ? instants[0]!.instant : chosen;
  const valid = !page.fields.time || !!instant;
  async function fresh(signal: AbortSignal) {
    const current = publicInvitationPage.parse(
      await api(`/public/invitations/${encodeURIComponent(page.eventId)}`, {
        signal,
      }),
    );
    signal.throwIfAborted();
    if (JSON.stringify(current) !== JSON.stringify(page))
      throw new Error(
        'The published invitation changed. Reload this page and review its latest details before downloading.',
      );
    return current;
  }
  async function download() {
    if (pending.current || !valid) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      const current = await fresh(controller.signal);
      const content = exportInvitationCalendar(
        current,
        window.location.origin,
        instant,
      );
      await fresh(controller.signal);
      controller.signal.throwIfAborted();
      saveFile(
        new Blob([content], { type: 'text/calendar;charset=utf-8' }),
        'picfind-invitation.ics',
      );
      setMessage(
        'Calendar download started. Import the saved file into your calendar and check the invitation page for later changes.',
      );
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure);
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  function cancel() {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setMessage('Calendar download cancelled.');
  }
  return (
    <section className="invitation-calendar" aria-label="Calendar reminder">
      <h2>Save the date</h2>
      <p>
        Download a calendar reminder from the current published invitation. This
        is a static copy. It does not update automatically, submit an RSVP or
        confirm admission.
      </p>
      {page.fields.time ? (
        <>
          <p>
            {page.fields.date} at {page.fields.time} ({page.fields.timeZone}).
            The host has not supplied an end time.
          </p>
          {instants.length > 1 && (
            <label>
              Intended occurrence of the repeated local time
              <select
                value={chosen}
                disabled={busy}
                onChange={(event) => {
                  setChosen(event.target.value);
                  setMessage('');
                  setError(null);
                }}
              >
                <option value="">
                  Confirm the time with the host and choose
                </option>
                {instants.map((value) => (
                  <option key={value.instant} value={value.instant}>
                    {value.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {instant && <p>Calendar start in UTC: {instant}.</p>}
        </>
      ) : (
        <p>
          All-day reminder for {page.fields.date}. No start time is published.
        </p>
      )}
      <ErrorNote error={error} />
      <button
        type="button"
        className="button secondary"
        disabled={busy || !valid}
        onClick={() => void download()}
      >
        Download calendar reminder
      </button>
      {busy && (
        <button type="button" className="button secondary" onClick={cancel}>
          Cancel calendar download
        </button>
      )}
      <p role="status">{message}</p>
    </section>
  );
}
