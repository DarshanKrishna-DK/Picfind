import { useEffect, useState, type FormEvent } from 'react';
import type { SelectionWindow } from '../../../../packages/shared/src/selection-window';
import { api } from '../api';
import { ErrorNote } from '../components/ui';

/** Server-relative elapsed time avoids trusting the guest device wall clock. */
export function useSelectionClosed(window?: SelectionWindow) {
  const [expiredAt, setExpiredAt] = useState<string | null>(null);
  useEffect(() => {
    if (!window?.closesAt || window.closed) return;
    const remaining =
      Date.parse(window.closesAt) - Date.parse(window.serverNow);
    const started = performance.now();
    const timer = setInterval(() => {
      if (performance.now() - started >= remaining) {
        setExpiredAt(window.closesAt);
        clearInterval(timer);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [window]);
  return Boolean(
    window?.closed || (window?.closesAt && window.closesAt === expiredAt),
  );
}

export function SelectionWindowNote({
  window,
}: {
  window: SelectionWindow | undefined;
}) {
  if (!window?.closesAt) return null;
  return (
    <p>
      Favorites deadline:{' '}
      <time dateTime={window.closesAt}>
        {new Date(window.closesAt).toLocaleString(undefined, {
          dateStyle: 'medium',
          timeStyle: 'long',
        })}
      </time>
      . Shown in your device time zone.
    </p>
  );
}

export function localDeadlineInput(value: string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function SelectionWindowForm({
  eventId,
  window,
  refresh,
}: {
  eventId: string;
  window: SelectionWindow | undefined;
  refresh: () => Promise<void>;
}) {
  const [deadline, setDeadline] = useState(
    localDeadlineInput(window?.closesAt),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const closed = useSelectionClosed(window);
  useEffect(() => {
    setDeadline(localDeadlineInput(window?.closesAt));
  }, [window?.closesAt]);
  async function save(
    command:
      { action: 'open' | 'close' } | { action: 'schedule'; closesAt: string },
  ) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      await api(`/events/${eventId}/selection-window`, {
        method: 'PATCH',
        body: JSON.stringify(command),
      });
      await refresh();
      setMessage('Submission window saved. Existing requests are unchanged.');
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  function schedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const date = new Date(deadline);
    if (
      !Number.isFinite(date.getTime()) ||
      localDeadlineInput(date.toISOString()) !== deadline
    ) {
      setError(new Error('Choose a valid local date and time.'));
      return;
    }
    void save({ action: 'schedule', closesAt: date.toISOString() });
  }
  return (
    <details className="selection-card">
      <summary>Favorites submission deadline</summary>
      <p role="status">
        {closed
          ? 'Favorites submissions are closed.'
          : 'Favorites submissions are open.'}
      </p>
      {window?.invalid && (
        <p className="notice">
          The stored deadline is invalid. Set a new deadline or reopen
          submissions.
        </p>
      )}
      <SelectionWindowNote window={window} />
      <p>
        Closing submissions keeps the gallery viewable and preserves saved
        requests. Gallery expiry still applies.
      </p>
      <form onSubmit={schedule}>
        <label>
          Submission deadline in your time zone
          <input
            type="datetime-local"
            value={deadline}
            onChange={(event) => setDeadline(event.target.value)}
            required
            disabled={busy}
          />
        </label>
        <p className="field-help">
          Time zone: {Intl.DateTimeFormat().resolvedOptions().timeZone}. The
          server checks the deadline when each request is submitted.
        </p>
        <button className="button secondary" disabled={busy}>
          Schedule submission deadline
        </button>
      </form>
      <div className="source-actions">
        <button
          className="button secondary"
          disabled={busy || closed}
          onClick={() => void save({ action: 'close' })}
        >
          Close submissions now
        </button>
        <button
          className="button secondary"
          disabled={busy || (!closed && !window?.closesAt)}
          onClick={() => void save({ action: 'open' })}
        >
          Reopen without deadline
        </button>
      </div>
      <ErrorNote error={error} />
      <p role="status">{message}</p>
    </details>
  );
}
