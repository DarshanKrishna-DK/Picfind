import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  PhotoAttribution,
  PublishedAttribution,
} from '../../../../packages/shared/src/photo-attribution';
import { api, HttpError } from '../api';
import { ErrorNote } from '../components/ui';

export function PublishedPhotoCredit({
  credit,
}: {
  credit: PublishedAttribution | undefined;
}) {
  if (!credit) return null;
  return (
    <p className="photo-credit">
      Photo by{' '}
      {credit.website ? (
        <a href={credit.website} target="_blank" rel="noopener noreferrer">
          {credit.name}
        </a>
      ) : (
        credit.name
      )}
    </p>
  );
}

export function PhotoAttributionEditor({ photoId }: { photoId: string }) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<PhotoAttribution | null>(null);
  const [draft, setDraft] = useState<PhotoAttribution | null>(null);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  const client = useQueryClient();
  async function request(save = false) {
    if (pending.current || (save && (!saved || !draft || locked))) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    setMessage('');
    if (!save) {
      setSaved(null);
      setDraft(null);
    }
    try {
      const response = await api<{ attribution: PhotoAttribution }>(
        `/photos/${photoId}/attribution`,
        {
          signal: controller.signal,
          ...(save
            ? {
                method: 'PATCH',
                body: JSON.stringify({
                  name: draft!.name,
                  website: draft!.website,
                  published: draft!.published,
                  version: saved!.version,
                }),
              }
            : {}),
        },
      );
      controller.signal.throwIfAborted();
      setSaved(response.attribution);
      setDraft(response.attribution);
      setLocked(false);
      if (save) {
        void client.invalidateQueries({ queryKey: ['library'] });
        setMessage(
          response.attribution.published
            ? 'Photographer credit published.'
            : 'Photographer credit saved privately. It is not included in new gallery exports.',
        );
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure);
        setLocked(true);
        if (
          !save ||
          (failure instanceof HttpError &&
            [401, 403, 404].includes(failure.status))
        ) {
          setSaved(null);
          setDraft(null);
        }
      }
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    if (open) void request();
    else {
      setSaved(null);
      setDraft(null);
      setError(null);
      setMessage('');
      setBusy(false);
    }
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [open, photoId]);
  function submit(event: FormEvent) {
    event.preventDefault();
    void request(true);
  }
  const unchanged =
    saved &&
    draft &&
    saved.name === draft.name &&
    saved.website === draft.website &&
    saved.published === draft.published;
  return (
    <details
      className="selection-card"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Photographer credit</summary>
      {open && (
        <>
          <p>
            Save a name and optional HTTPS website. Publish only with the
            photographer's permission. Account names are never filled in
            automatically.
          </p>
          <p>
            Published credit appears in galleries and credits.csv inside ZIP
            downloads. Individual JPEG bytes remain unchanged. Previously
            downloaded copies cannot be recalled.
          </p>
          <ErrorNote error={error} />
          {draft && (
            <form onSubmit={submit}>
              <fieldset disabled={busy}>
                <label>
                  Credit name
                  <input
                    value={draft.name}
                    maxLength={100}
                    onChange={(event) =>
                      setDraft({ ...draft, name: event.target.value })
                    }
                  />
                </label>
                <label>
                  Photographer website
                  <input
                    type="url"
                    value={draft.website}
                    maxLength={512}
                    placeholder="https://example.com"
                    onChange={(event) =>
                      setDraft({ ...draft, website: event.target.value })
                    }
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={draft.published}
                    onChange={(event) =>
                      setDraft({ ...draft, published: event.target.checked })
                    }
                  />
                  Publish this credit in the gallery and new ZIP downloads
                </label>
                <button
                  type="submit"
                  className="button secondary"
                  disabled={locked || Boolean(unchanged)}
                >
                  Save photographer credit
                </button>
              </fieldset>
            </form>
          )}
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => void request()}
          >
            {draft
              ? 'Replace draft with latest credit'
              : 'Load photographer credit'}
          </button>
          <p role="status">
            {busy ? 'Checking photographer credit...' : message}
          </p>
        </>
      )}
    </details>
  );
}
