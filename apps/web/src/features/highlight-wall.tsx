import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, session, type Photo } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import { PublishedPhotoCredit } from './photo-attribution';
import './highlight-wall.css';

const FRESHNESS_MS = 45_000;
export function HighlightWall() {
  const { eventId } = useParams();
  return <WallView key={eventId} eventId={eventId!} />;
}
function WallView({ eventId }: { eventId: string }) {
  const account = useQuery({ queryKey: ['session'], queryFn: session });
  const query = useQuery({
    queryKey: ['highlight-wall', eventId, account.data?.id],
    queryFn: async ({ signal }) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const timer = window.setTimeout(abort, 10_000);
      try {
        return await api<{ title: string; photos: Photo[] }>(
          `/public/highlights/${eventId}`,
          { signal: controller.signal },
        );
      } finally {
        window.clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      }
    },
    enabled: Boolean(account.data),
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const [playing, setPlaying] = useState(false);
  const [seconds, setSeconds] = useState(10);
  const [photoId, setPhotoId] = useState('');
  const [visible, setVisible] = useState(
    () => document.visibilityState === 'visible',
  );
  const [online, setOnline] = useState(() => navigator.onLine);
  const [minimumResponseAt, setMinimumResponseAt] = useState(() => Date.now());
  const [expiredAt, setExpiredAt] = useState(0);
  const [imageFailed, setImageFailed] = useState(false);
  const [imageAttempt, setImageAttempt] = useState(0);
  const [message, setMessage] = useState('');
  const stage = useRef<HTMLElement>(null);
  const currentPhotos = useRef<Photo[]>([]);
  const photos = query.data?.photos ?? [];
  const index = Math.max(
    0,
    photos.findIndex((photo) => photo.id === photoId),
  );
  const ready = Boolean(
    account.data &&
    !account.error &&
    !query.error &&
    visible &&
    online &&
    !imageFailed &&
    query.data &&
    query.dataUpdatedAt >= minimumResponseAt &&
    query.dataUpdatedAt > expiredAt &&
    Date.now() < query.dataUpdatedAt + FRESHNESS_MS,
  );
  const photo = ready ? photos[index] : undefined;
  useEffect(() => {
    currentPhotos.current = query.data?.photos ?? [];
    if (currentPhotos.current.length < 2) setPlaying(false);
    if (!currentPhotos.current.some((item) => item.id === photoId)) {
      setPhotoId(currentPhotos.current[0]?.id ?? '');
      setPlaying(false);
    }
  }, [query.data, photoId]);
  useEffect(() => {
    if (!ready) setPlaying(false);
  }, [ready]);
  useEffect(() => {
    const updatedAt = query.dataUpdatedAt;
    if (!updatedAt) return;
    const timer = window.setTimeout(
      () => {
        setExpiredAt(updatedAt);
        setPlaying(false);
      },
      Math.max(0, updatedAt + FRESHNESS_MS - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [query.dataUpdatedAt]);
  const refetch = query.refetch;
  useEffect(() => {
    function visibilityChanged() {
      const isVisible = document.visibilityState === 'visible';
      setVisible(isVisible);
      setPlaying(false);
      setMinimumResponseAt(Date.now());
      if (isVisible && navigator.onLine) void refetch();
    }
    function connectivityChanged() {
      setOnline(navigator.onLine);
      setPlaying(false);
      setMinimumResponseAt(Date.now());
      if (navigator.onLine && document.visibilityState === 'visible')
        void refetch();
    }
    document.addEventListener('visibilitychange', visibilityChanged);
    window.addEventListener('online', connectivityChanged);
    window.addEventListener('offline', connectivityChanged);
    return () => {
      document.removeEventListener('visibilitychange', visibilityChanged);
      window.removeEventListener('online', connectivityChanged);
      window.removeEventListener('offline', connectivityChanged);
    };
  }, [refetch]);
  useEffect(() => {
    if (!playing || !ready) return;
    const timer = window.setInterval(() => {
      setPhotoId((current) => {
        const items = currentPhotos.current;
        if (!items.length) return '';
        const currentIndex = items.findIndex((item) => item.id === current);
        return items[(currentIndex + 1) % items.length]!.id;
      });
    }, seconds * 1000);
    return () => window.clearInterval(timer);
  }, [playing, ready, seconds]);
  function move(delta: number) {
    setPlaying(false);
    if (photos.length)
      setPhotoId(photos[(index + delta + photos.length) % photos.length]!.id);
  }
  function refresh() {
    setPlaying(false);
    setImageFailed(false);
    setImageAttempt((value) => value + 1);
    setMinimumResponseAt(Date.now());
    void query.refetch();
  }
  async function fullscreen() {
    try {
      if (!stage.current?.requestFullscreen)
        throw new Error('Fullscreen unavailable');
      await stage.current.requestFullscreen();
      setMessage(
        'Fullscreen is open. Use Escape or the browser control to leave fullscreen.',
      );
    } catch {
      setMessage(
        'Fullscreen is unavailable in this browser. The photo wall remains available here.',
      );
    }
  }
  if (account.isPending) return <Loading />;
  if (account.error) return <ErrorNote error={account.error} />;
  if (!account.data)
    return (
      <section className="wrap standalone">
        <h1>Event photo wall</h1>
        <p>Sign in to view the published highlights.</p>
        <Link
          className="button"
          to={`/sign-in?returnTo=${encodeURIComponent(`/highlights/${eventId}/wall`)}`}
        >
          Sign in to view photo wall
        </Link>
      </section>
    );
  return (
    <section
      ref={stage}
      className="highlight-wall"
      aria-label="Event photo wall"
    >
      <header>
        <h1>{ready ? query.data?.title : 'Event photo wall'}</h1>
        <Link to={`/highlights/${eventId}`}>Back to highlights</Link>
      </header>
      <div className="highlight-wall-picture">
        {photo ? (
          <figure>
            <img
              key={`${photo.id}:${imageAttempt}`}
              src={`/api/public/highlights/${encodeURIComponent(eventId!)}/photos/${encodeURIComponent(photo.id)}?wallAttempt=${imageAttempt}`}
              alt={photo.filename}
              onError={() => {
                setImageFailed(true);
                setPlaying(false);
              }}
            />
            <figcaption>
              <PublishedPhotoCredit credit={photo.credit} />
            </figcaption>
          </figure>
        ) : (
          <div role="status">
            {!online
              ? 'Offline. Photos are hidden until access can be checked again.'
              : !visible
                ? 'The wall is paused while this tab is hidden.'
                : imageFailed
                  ? 'This photo could not be loaded. Refresh the wall to check access again.'
                  : query.error
                    ? 'Highlights are unavailable. Refresh to check access again.'
                    : ready
                      ? 'No published photos are currently available.'
                      : query.isFetching || query.isPending
                        ? 'Checking current highlight access...'
                        : 'The access check is out of date. Refresh the wall to continue.'}
          </div>
        )}
      </div>
      <footer>
        <p aria-live="polite">
          {photo
            ? `${index + 1} of ${photos.length} photos. ${playing ? 'Slideshow playing.' : 'Slideshow paused.'}`
            : 'Slideshow paused.'}
        </p>
        <div className="actions">
          <button
            type="button"
            className="button secondary"
            disabled={!photo || photos.length < 2}
            onClick={() => move(-1)}
          >
            Previous photo
          </button>
          <button
            type="button"
            className="button"
            disabled={!photo || photos.length < 2}
            onClick={() => setPlaying((value) => !value)}
          >
            {playing ? 'Pause slideshow' : 'Start slideshow'}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={!photo || photos.length < 2}
            onClick={() => move(1)}
          >
            Next photo
          </button>
          <label>
            Photo interval
            <select
              value={seconds}
              onChange={(event) => {
                setPlaying(false);
                setSeconds(Number(event.target.value));
              }}
            >
              {[5, 10, 15].map((value) => (
                <option key={value} value={value}>
                  {value} seconds
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="button secondary"
            disabled={query.isFetching || !online}
            onClick={refresh}
          >
            Refresh wall
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => void fullscreen()}
          >
            Open fullscreen
          </button>
        </div>
        <p role="status">{message}</p>
        <p className="field-help">
          Only published highlights appear. Access refreshes every 15 seconds
          while visible. A failed check hides the photos. Playback resumes only
          when you start it.
        </p>
      </footer>
    </section>
  );
}
