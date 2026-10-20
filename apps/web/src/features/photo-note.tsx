import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PrivatePhotoNote } from '../../../../packages/shared/src/photo-note';
import { api, HttpError } from '../api';
import { ErrorNote, Loading } from '../components/ui';

export function PhotoNote({ photoId }: { photoId: string }) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ['private-photo-note', photoId],
    queryFn: ({ signal }) =>
      api<{ note: PrivatePhotoNote }>(`/photos/${photoId}/private-note`, {
        signal,
      }),
    enabled: open,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  return (
    <details
      className="selection-card"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Private photo instructions</summary>
      <p>Only you can read this note. Save before changing photos.</p>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <>
          <ErrorNote error={query.error} />
          <button
            className="button secondary"
            onClick={() => void query.refetch()}
          >
            Retry loading note
          </button>
        </>
      ) : query.data ? (
        <PhotoNoteEditor photoId={photoId} initial={query.data.note} />
      ) : null}
    </details>
  );
}

function PhotoNoteEditor({
  photoId,
  initial,
}: {
  photoId: string;
  initial: PrivatePhotoNote;
}) {
  const client = useQueryClient();
  const [saved, setSaved] = useState(initial);
  const [text, setText] = useState(initial.text);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function persist(event: FormEvent) {
    event.preventDefault();
    if (pending.current || conflict) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      const result = await api<{ note: PrivatePhotoNote }>(
        `/photos/${photoId}/private-note`,
        {
          method: 'PATCH',
          signal: controller.signal,
          body: JSON.stringify({ text, version: saved.version }),
        },
      );
      if (controller.signal.aborted) return;
      setSaved(result.note);
      setText(result.note.text);
      client.setQueryData(['private-photo-note', photoId], result);
      setMessage(
        result.note.text ? 'Private note saved.' : 'Private note cleared.',
      );
    } catch (failure) {
      if (controller.signal.aborted) return;
      setError(failure);
      if (failure instanceof HttpError && failure.code === 'PHOTO_NOTE_CHANGED')
        setConflict(true);
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function reload() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      const result = await api<{ note: PrivatePhotoNote }>(
        `/photos/${photoId}/private-note`,
        {
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted) return;
      setSaved(result.note);
      setText(result.note.text);
      client.setQueryData(['private-photo-note', photoId], result);
      setConflict(false);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure);
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <form onSubmit={(event) => void persist(event)}>
      <label>
        Private editing note
        <textarea
          value={text}
          maxLength={2000}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <p className="field-help">
        {text.length} / 2,000 characters. Save an empty note to clear it.
      </p>
      <button
        className="button secondary"
        disabled={busy || conflict || text === saved.text}
      >
        Save private note
      </button>
      {conflict && (
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void reload()}
        >
          Replace draft with latest note
        </button>
      )}
      <ErrorNote error={error} />
      <p role="status">{message}</p>
    </form>
  );
}
