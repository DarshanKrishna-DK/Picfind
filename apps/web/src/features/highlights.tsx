import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, HttpError, session, type Photo } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import { PhotoGrid } from '../components/photo-grid';
import {
  HIGHLIGHT_PHOTO_LIMIT,
  type HighlightDraft,
} from '../../../../packages/shared/src/highlights';

export function HighlightsEditor({
  eventId,
  photos,
}: {
  eventId: string;
  photos: Photo[];
}) {
  const [saved, setSaved] = useState<HighlightDraft | null>(null);
  const [draft, setDraft] = useState<HighlightDraft | null>(null);
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(true);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const saveRequest = useRef<AbortController | null>(null);
  const endpoint = `/events/${eventId}/highlights`;
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setDraft(null);
    setSaved(null);
    setError(null);
    setMessage('');
    void api<{ highlights: HighlightDraft; unavailableIds: string[] }>(
      endpoint,
      { signal: controller.signal },
    )
      .then((result) => {
        setSaved(result.highlights);
        setDraft(result.highlights);
        setUnavailable(result.unavailableIds);
        setLocked(false);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => {
      controller.abort();
      saveRequest.current?.abort();
    };
  }, [endpoint, reload]);
  async function save() {
    if (!draft || busy || locked) return;
    const controller = new AbortController();
    saveRequest.current = controller;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      const result = await api<{ highlights: HighlightDraft }>(endpoint, {
        method: 'PATCH',
        signal: controller.signal,
        body: JSON.stringify({
          title: draft.title,
          photoIds: draft.photoIds,
          published: draft.published,
          version: draft.version,
        }),
      });
      if (controller.signal.aborted) return;
      setSaved(result.highlights);
      setDraft(result.highlights);
      setMessage(
        result.highlights.published
          ? 'Highlights published. Only the saved selection is available through this link.'
          : 'Private highlight draft saved. The highlights link is unavailable.',
      );
    } catch (failure) {
      if (controller.signal.aborted) return;
      setError(failure);
      if (failure instanceof HttpError && failure.status === 409)
        setLocked(true);
      if (
        failure instanceof HttpError &&
        [401, 403, 404].includes(failure.status)
      ) {
        setDraft(null);
        setSaved(null);
        setLocked(true);
      }
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        saveRequest.current = null;
      }
    }
  }
  function move(index: number, delta: number) {
    if (!draft) return;
    const next = [...draft.photoIds];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    setDraft({ ...draft, photoIds: next });
  }
  const eligible = photos.filter((photo) => photo.eventId === eventId);
  const byId = new Map(eligible.map((photo) => [photo.id, photo]));
  const choices = eligible.filter(
    (photo) =>
      !draft?.photoIds.includes(photo.id) &&
      photo.filename.toLowerCase().includes(search.trim().toLowerCase()),
  );
  return (
    <section className="settings-panel" aria-label="Curated highlights">
      <h2>Curated highlights</h2>
      <p>
        Publish up to 100 selected photos without opening the full event
        gallery. Signed-in guests with the link can view and download this
        selection. Only publish photos you have permission to share.
      </p>
      <p>
        The first available photo is the cover. Changes take effect when saved.
        Previously downloaded copies cannot be recalled.
      </p>
      <ErrorNote error={error} />
      {busy && !draft && <Loading />}
      {draft && (
        <fieldset disabled={busy || locked}>
          <label>
            Highlight title
            <input
              value={draft.title}
              maxLength={100}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <p>
            {draft.photoIds.length} of {HIGHLIGHT_PHOTO_LIMIT} photos selected
          </p>
          <ol aria-label="Highlight order">
            {draft.photoIds.map((photoId, index) => {
              const photo = byId.get(photoId);
              const name = photo?.filename ?? photoId;
              return (
                <li key={photoId}>
                  <span>
                    {name}
                    {index === 0 ? ' (cover when available)' : ''}
                    {!photo || unavailable.includes(photoId)
                      ? ' (unavailable, remove before publishing)'
                      : ''}
                  </span>
                  <div className="actions">
                    <button
                      type="button"
                      className="button secondary"
                      aria-label={`Move ${name} up`}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      aria-label={`Move ${name} down`}
                      disabled={index === draft.photoIds.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      Down
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      aria-label={`Remove ${name} from highlights`}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          photoIds: draft.photoIds.filter(
                            (key) => key !== photoId,
                          ),
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
          <label>
            Find event photos
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <p>
            {choices.length > 50
              ? 'Showing the first 50 matches. Refine the filename to find another photo.'
              : `${choices.length} photos available to add.`}
          </p>
          <div className="actions">
            {choices.slice(0, 50).map((photo) => (
              <button
                key={photo.id}
                type="button"
                className="button secondary"
                disabled={draft.photoIds.length >= HIGHLIGHT_PHOTO_LIMIT}
                onClick={() =>
                  setDraft({
                    ...draft,
                    photoIds: [...draft.photoIds, photo.id],
                  })
                }
              >
                Add {photo.filename}
              </button>
            ))}
          </div>
          <label>
            <input
              type="checkbox"
              checked={draft.published}
              onChange={(e) =>
                setDraft({ ...draft, published: e.target.checked })
              }
            />
            Publish selected highlights for signed-in guests with the link
          </label>
          <button
            type="button"
            className="button"
            disabled={
              !draft.title.trim() || (draft.published && !draft.photoIds.length)
            }
            onClick={() => void save()}
          >
            Save highlights
          </button>
        </fieldset>
      )}
      <p role="status">{message}</p>
      <button
        type="button"
        className="button secondary"
        disabled={busy}
        onClick={() => setReload((value) => value + 1)}
      >
        Replace draft with latest highlights
      </button>
      {saved?.published && (
        <label>
          Published highlights link
          <input
            readOnly
            value={`${window.location.origin}/highlights/${eventId}`}
            onFocus={(e) => e.target.select()}
          />
        </label>
      )}
    </section>
  );
}

export function HighlightsPage() {
  const { eventId } = useParams();
  const account = useQuery({ queryKey: ['session'], queryFn: session });
  const query = useQuery({
    queryKey: ['public-highlights', eventId, account.data?.id],
    queryFn: ({ signal }) =>
      api<{ title: string; coverId: string | null; photos: Photo[] }>(
        `/public/highlights/${eventId}`,
        { signal },
      ),
    enabled: Boolean(account.data),
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
    retry: false,
  });
  return (
    <section className="wrap standalone" aria-label="Published highlights">
      {account.isPending ? (
        <Loading />
      ) : account.error ? (
        <ErrorNote error={account.error} />
      ) : !account.data ? (
        <>
          <h1>Event highlights</h1>
          <p>Sign in to view the photographer selection.</p>
          <Link
            className="button"
            to={`/sign-in?returnTo=${encodeURIComponent(`/highlights/${eventId}`)}`}
          >
            Sign in to view highlights
          </Link>
        </>
      ) : query.isPending ? (
        <Loading />
      ) : (
        <>
          {query.error ? (
            <>
              <h1>Highlights are unavailable.</h1>
              <ErrorNote error={query.error} />
            </>
          ) : (
            query.data && (
              <>
                <h1>{query.data.title}</h1>
                <p>
                  {query.data.photos.length} selected photos. Downloads include
                  only this published selection.
                </p>
                <PhotoGrid
                  key={`${eventId}:${account.data.id}`}
                  photos={query.data.photos}
                  readOnly
                  preserveOrder
                  photoUrl={(photoId) =>
                    `/api/public/highlights/${encodeURIComponent(eventId!)}/photos/${encodeURIComponent(photoId)}`
                  }
                />
              </>
            )
          )}
          <button
            type="button"
            className="button secondary"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Refresh highlights
          </button>
        </>
      )}
    </section>
  );
}
