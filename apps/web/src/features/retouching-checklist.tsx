import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import {
  RETOUCHING_CHANGE_LIMIT,
  RETOUCHING_STATUSES,
  retouchingTransition,
  type RetouchingChecklist as Checklist,
  type RetouchingItem,
  type RetouchingStatus,
} from '../../../../packages/shared/src/retouching';

export function RetouchingChecklist({
  root,
  disabled,
}: {
  root: string;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Retouching checklist">
      <button
        className="button secondary"
        disabled={disabled}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? 'Close retouching checklist' : 'Open retouching checklist'}
      </button>
      {open && <ChecklistPanel key={root} root={root} disabled={disabled} />}
    </section>
  );
}

function ChecklistPanel({
  root,
  disabled,
}: {
  root: string;
  disabled: boolean;
}) {
  const [data, setData] = useState<Checklist | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    pending.current = controller;
    void api<Checklist>(root, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
        if (pending.current === controller) pending.current = null;
      });
    return () => {
      controller.abort();
      pending.current?.abort();
    };
  }, [root]);
  async function refreshOrSave(
    item?: RetouchingItem,
    status?: RetouchingStatus,
    note?: string,
  ) {
    if (pending.current || disabled) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    setMessage('');
    setData(null);
    try {
      if (item)
        await api(`${root}/${item.photoId}`, {
          method: 'PATCH',
          signal: controller.signal,
          body: JSON.stringify({ version: item.version, status, note }),
        });
      const fresh = await api<Checklist>(root, { signal: controller.signal });
      if (!controller.signal.aborted) {
        setData(fresh);
        setMessage(
          item ? 'Retouching progress saved.' : 'Checklist refreshed.',
        );
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (pending.current === controller) pending.current = null;
    }
  }
  return (
    <div className="stack">
      <p>
        Private work tracking for the photographer. Ready is your work status;
        it does not upload or deliver an edited file.
      </p>
      <ErrorNote error={error} />
      <p role="status">{message}</p>
      <button
        className="button secondary"
        disabled={busy || disabled}
        onClick={() => void refreshOrSave()}
      >
        Refresh retouching checklist
      </button>
      {busy && <Loading />}
      {data && (
        <>
          <p>
            {data.items.filter((item) => item.status === 'ready').length} of{' '}
            {data.items.length} available photos ready.
          </p>
          {data.unavailableCount > 0 && (
            <p>
              {data.unavailableCount} submitted photos are unavailable in this
              collection.
            </p>
          )}
          {data.readOnly && (
            <p>This event is read-only. Saved progress remains visible.</p>
          )}
          {!data.items.length && (
            <p>No submitted photos are currently available for retouching.</p>
          )}
          {data.items.map((item) => (
            <WorkItem
              key={`${item.photoId}:${item.version}`}
              item={item}
              disabled={disabled || data.readOnly || busy}
              onSave={(status, note) => void refreshOrSave(item, status, note)}
            />
          ))}
        </>
      )}
    </div>
  );
}

function WorkItem({
  item,
  disabled,
  onSave,
}: {
  item: RetouchingItem;
  disabled: boolean;
  onSave: (status: RetouchingStatus, note: string) => void;
}) {
  const [status, setStatus] = useState(item.status);
  const [note, setNote] = useState(item.note);
  const capacity = item.version >= RETOUCHING_CHANGE_LIMIT;
  const changed = status !== item.status || note.trim() !== item.note;
  function save(event: FormEvent) {
    event.preventDefault();
    if (
      disabled ||
      capacity ||
      !changed ||
      !retouchingTransition(item.status, status, note)
    )
      return;
    onSave(status, note.trim());
  }
  return (
    <article aria-label={`Retouch ${item.filename} ${item.photoId}`}>
      <h5>{item.filename}</h5>
      <p>Photo ID: {item.photoId}</p>
      <form onSubmit={save}>
        <fieldset disabled={disabled || capacity}>
          <label>
            Work status
            <select
              value={status}
              onChange={(event) =>
                setStatus(event.target.value as RetouchingStatus)
              }
            >
              {RETOUCHING_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label>
            Private work note
            <textarea
              maxLength={200}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <p>
            Start queued work by moving it to editing. Explain any return to an
            earlier status.
          </p>
          <button
            className="button"
            disabled={
              !changed || !retouchingTransition(item.status, status, note)
            }
          >
            Save work progress
          </button>
        </fieldset>
      </form>
      {capacity && (
        <p>
          This photo has reached 30 recorded changes for this round. Its history
          is retained.
        </p>
      )}
      <details>
        <summary>Work history ({item.history.length})</summary>
        {!item.history.length ? (
          <p>No work changes recorded.</p>
        ) : (
          <ol>
            {item.history.map((change) => (
              <li key={change.version}>
                {new Date(change.at).toLocaleString()}: {change.status}
                {change.note && `, ${change.note}`}
              </li>
            ))}
          </ol>
        )}
      </details>
    </article>
  );
}
