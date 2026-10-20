import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { ScanFace, Trash2 } from 'lucide-react';
import { MenuSelect } from '../components/menu-select';
import {
  api,
  type Capabilities,
  type DiscoverScan,
  type FaceMatch,
} from '../api';
import { useLibrary } from '../hooks';
import { ErrorNote, PageTitle } from '../components/ui';
import { PhotoGrid } from '../components/photo-grid';
import './sources.css';

export function DiscoverPage() {
  const capabilities = useQuery({
    queryKey: ['capabilities'],
    queryFn: () => api<Capabilities>('/capabilities'),
  });
  const library = useLibrary();
  const client = useQueryClient();
  const [params] = useSearchParams();
  useEffect(() => {
    if (params.get('drive') === 'connected')
      void client.invalidateQueries({ queryKey: ['capabilities'] });
  }, [client, params]);
  const selfie = useRef<HTMLInputElement>(null);
  const [selfieName, setSelfieName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [sourceEvent, setSourceEvent] = useState('all');
  const matchingSources = (library.data?.photos ?? []).filter(
    (photo) =>
      sourceEvent === 'all' ||
      (sourceEvent === 'unassigned'
        ? !photo.eventId
        : photo.eventId === sourceEvent),
  );
  const libraryPhotoKey = (library.data?.photos ?? [])
    .map((photo) => `${photo.id}:${photo.eventId ?? ''}`)
    .join();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [scan, setScan] = useState<DiscoverScan | null>(null);
  const [matches, setMatches] = useState<FaceMatch[]>([]);
  const [searched, setSearched] = useState(false);
  const limit =
    capabilities.data?.discoverJobLimit ??
    capabilities.data?.faceIndexMax ??
    20;
  const attempt = useRef<{ fingerprint: string; requestId: string } | null>(
    null,
  );
  const retryAttempt = useRef<string | null>(null);
  const activeAction = useRef(false);
  const [retryUncertain, setRetryUncertain] = useState(false);
  const processing = scan?.processing;
  const processingActive = Boolean(
    processing && ['queued', 'running'].includes(processing.status),
  );
  const poll = useQuery({
    queryKey: ['discover-scan', scan?.id],
    queryFn: ({ signal }) =>
      api<{ scan: DiscoverScan; matches: FaceMatch[] }>(
        `/discover/scans/${scan!.id}`,
        { signal },
      ),
    enabled: Boolean(
      scan &&
      scan.resultsRetained === false &&
      processingActive &&
      !scan.deleting,
    ),
    refetchInterval: 3000,
    retry: false,
  });
  useEffect(() => {
    if (!poll.data || poll.data.scan.id !== scan?.id) return;
    setScan(poll.data.scan);
    if (
      !['queued', 'running'].includes(poll.data.scan.processing?.status ?? '')
    ) {
      setStatus(
        poll.data.scan.indexed
          ? 'Your collection is ready. Use your reference selfie to search it.'
          : 'Processing stopped. Review the details below.',
      );
      void client.invalidateQueries({ queryKey: ['library'] });
    }
  }, [poll.data, scan?.id, client]);
  useEffect(() => {
    if (scan) return;
    const next = (library.data?.photos ?? []).filter(
      (photo) =>
        sourceEvent === 'all' ||
        (sourceEvent === 'unassigned'
          ? !photo.eventId
          : photo.eventId === sourceEvent),
    );
    setSelected(next.slice(0, limit).map((photo) => photo.id));
  }, [sourceEvent, limit, scan, libraryPhotoKey]);
  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (activeAction.current || processingActive || scan?.deleting) return;
    const form = new FormData(event.currentTarget);
    if (!form.get('consent')) {
      setError(
        new Error('Confirm the face-matching notice before continuing.'),
      );
      return;
    }
    const file = selfie.current?.files?.[0];
    if (!file) {
      setError(
        new Error('Add a reference selfie that shows exactly one face.'),
      );
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setError(new Error('Choose a selfie smaller than 8 MB.'));
      return;
    }
    if (!scan && !selected.length) {
      setError(new Error('Select at least one library photo.'));
      return;
    }
    activeAction.current = true;
    let startingSavedScan = false;
    setBusy(true);
    setError(null);
    setMatches([]);
    setSearched(false);
    try {
      let active = scan;
      if (!active) {
        setStatus(
          'Preparing your selected collection. This may take a moment.',
        );
        startingSavedScan = capabilities.data?.durableDiscover === true;
        const fingerprint = JSON.stringify({
          selected: [...selected].sort(),
        });
        if (startingSavedScan && attempt.current?.fingerprint !== fingerprint)
          attempt.current = { fingerprint, requestId: crypto.randomUUID() };
        const result = await api<{ scan: DiscoverScan }>('/discover/scans', {
          method: 'POST',
          body: JSON.stringify({
            photoIds: selected,
            ...(startingSavedScan
              ? { requestId: attempt.current!.requestId }
              : {}),
            consent: true,
            policyVersion: 'face-matching-v1',
          }),
        });
        active = result.scan;
        setScan(active);
        await client.invalidateQueries({ queryKey: ['library'] });
      }
      if (
        active.processing &&
        ['queued', 'running'].includes(active.processing.status)
      ) {
        setStatus(
          'Processing is saved. You can leave and return; your selfie stays only in this browser until you choose to search.',
        );
        return;
      }
      if (!['complete', 'partial'].includes(active.state))
        throw new Error(
          active.errors.join(' ') || 'This collection is not ready for search.',
        );
      setStatus(
        'Searching with your reference photo. The selfie is not stored.',
      );
      const result = await api<{
        scan: DiscoverScan;
        matches: FaceMatch[];
        limitReached?: boolean;
      }>(`/discover/scans/${active.id}/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name),
        },
        body: file,
      });
      setScan(result.scan);
      setMatches(result.matches);
      setSearched(true);
      setStatus(
        result.limitReached
          ? 'The provider result limit was reached. Some likely matches may not be shown.'
          : `${result.matches.length} likely matches. Scores describe similarity, not guaranteed identity.`,
      );
      await client.invalidateQueries({ queryKey: ['library'] });
    } catch (failure) {
      if (startingSavedScan && attempt.current) {
        try {
          const restored = await api<{ scans?: DiscoverScan[] }>('/library');
          const saved = restored.scans?.find(
            (item) => item.requestId === attempt.current!.requestId,
          );
          if (saved) {
            setScan(saved);
            setError(null);
            setStatus(
              'Your saved processing request was recovered. No second batch was started.',
            );
            return;
          }
        } catch {
          /* Keep the original error and the same request ID for a safe retry. */
        }
      }
      setError(failure);
    } finally {
      activeAction.current = false;
      setBusy(false);
    }
  }
  async function resume(id: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ scan: DiscoverScan; matches: FaceMatch[] }>(
        `/discover/scans/${id}`,
      );
      setScan(result.scan);
      setMatches(result.matches);
      setSearched(result.matches.length > 0);
      setStatus(
        result.scan.resultsRetained === false
          ? 'Collection restored. Add a fresh selfie to search when processing is ready; selfies and result lists are not retained.'
          : 'Search restored. You can download previous matches or use another selfie without indexing again.',
      );
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!scan) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/discover/scans/${scan.id}`, { method: 'DELETE' });
      setScan(null);
      attempt.current = null;
      retryAttempt.current = null;
      setMatches([]);
      setSearched(false);
      setStatus('This search session and its face index were deleted.');
      await client.invalidateQueries({ queryKey: ['library'] });
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  async function manageProcessing(cancel: boolean) {
    if (!scan || activeAction.current) return;
    activeAction.current = true;
    setBusy(true);
    setError(null);
    try {
      await client.cancelQueries({ queryKey: ['discover-scan', scan.id] });
      if (!cancel) retryAttempt.current ??= crypto.randomUUID();
      const result = await api<{ scan: DiscoverScan; matches?: FaceMatch[] }>(
        `/discover/scans/${scan.id}/processing${cancel ? '/cancel' : ''}`,
        {
          method: 'POST',
          body: JSON.stringify(
            cancel
              ? {}
              : {
                  requestId: retryAttempt.current,
                  consent: true,
                  policyVersion: 'face-matching-v1',
                  retryUncertain,
                },
          ),
        },
      );
      retryAttempt.current = null;
      setRetryUncertain(false);
      setScan(result.scan);
      client.setQueryData(['discover-scan', scan.id], result);
      setStatus(
        cancel
          ? 'Processing will pause after the current photo. Completed work is saved.'
          : 'Remaining work is saved for processing.',
      );
      await client.invalidateQueries({ queryKey: ['library'] });
    } catch (failure) {
      try {
        const saved = await api<{ scan: DiscoverScan; matches: FaceMatch[] }>(
          `/discover/scans/${scan.id}`,
        );
        if (
          !cancel &&
          saved.scan.processing?.requestId === retryAttempt.current
        ) {
          setScan(saved.scan);
          retryAttempt.current = null;
          setError(null);
          setStatus(
            'Your saved resume request was recovered without another batch.',
          );
          return;
        }
      } catch {
        /* Keep the retry identity and show the original failure. */
      }
      setError(failure);
    } finally {
      activeAction.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <PageTitle eyebrow="FIND YOUR PHOTOS" title="Your face. Your moments." />
      <p className="page-description">
        Import an album first, then pick it here, add a selfie, and review
        likely matches. PicFind searches copies in your library, not the
        original Drive, folder, or cloud account.
      </p>
      {!capabilities.data?.faceMatching && (
        <p className="notice">
          Photo matching is unavailable right now. Your library and downloads
          remain available.
        </p>
      )}
      <ErrorNote error={capabilities.error ?? library.error} />
      <ErrorNote error={poll.error} />
      {!library.data?.photos.length && !scan && (
        <section className="source-panel discover-empty">
          <h2>Import photos before you search</h2>
          <p>
            Face matching runs on photos already in PicFind. Upload a folder or
            copy from Google Drive or another cloud account, then return here
            with a selfie.
          </p>
          <Link className="button" to="/app/import">
            Import photos
          </Link>
        </section>
      )}
      {!!library.data?.scans?.length && !scan && (
        <section className="scan-history">
          <h2>Continue a previous search</h2>
          {library.data.scans.map((item) => (
            <button
              className="button secondary"
              disabled={busy}
              key={item.id}
              onClick={() => void resume(item.id)}
            >
              {new Date(item.createdAt).toLocaleDateString()} / {item.imported}{' '}
              photos / {item.state}
            </button>
          ))}
        </section>
      )}
      {(!!library.data?.photos.length || scan) && (
        <form className="form-panel" onSubmit={(event) => void start(event)}>
          {!!library.data?.photos.length && (
            <>
              <div className="source-panel">
                <label>
                  Imported album
                  <MenuSelect
                    label="Imported album"
                    value={sourceEvent}
                    disabled={busy || Boolean(scan)}
                    onChange={setSourceEvent}
                    options={[
                      { value: 'all', label: 'All imported photos' },
                      { value: 'unassigned', label: 'Personal library' },
                      ...(library.data?.events.map((event) => ({
                        value: event.id,
                        label: event.title,
                      })) ?? []),
                    ]}
                  />
                </label>
                <p>
                  {selected.length} of {limit} photos from this album will be
                  searched.
                </p>
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy || Boolean(scan) || !matchingSources.length}
                  onClick={() =>
                    setSelected(
                      matchingSources.slice(0, limit).map((photo) => photo.id),
                    )
                  }
                >
                  Use this album
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy || Boolean(scan) || !selected.length}
                  onClick={() => setSelected([])}
                >
                  Clear selection
                </button>
                <p className="field-help">
                  Changing album selects its photos automatically, up to this
                  collection's limit. Import a different source from Import
                  photos.
                </p>
                <p>
                  <Link className="text-link" to="/app/import">
                    Import more photos
                  </Link>
                </p>
              </div>
              <div className="source-list">
                {matchingSources.slice(0, 100).map((photo) => (
                  <label key={photo.id}>
                    <input
                      type="checkbox"
                      disabled={
                        busy ||
                        Boolean(scan) ||
                        (!selected.includes(photo.id) &&
                          selected.length >= limit)
                      }
                      checked={selected.includes(photo.id)}
                      onChange={(event) =>
                        setSelected((previous) =>
                          event.target.checked
                            ? [...previous, photo.id]
                            : previous.filter((id) => id !== photo.id),
                        )
                      }
                    />
                    {photo.filename}
                  </label>
                ))}
              </div>
            </>
          )}
          <div className="file-field">
            <span>Reference selfie</span>
            <input
              ref={selfie}
              id="reference-selfie"
              className="file-field-input"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              required
              disabled={busy}
              aria-label="Reference selfie"
              onChange={(event) =>
                setSelfieName(event.target.files?.[0]?.name ?? '')
              }
            />
            <div className="file-field-row">
              <label className="button secondary" htmlFor="reference-selfie">
                Choose photo
              </label>
              <span>{selfieName || 'JPEG, PNG or WebP · one clear face'}</span>
            </div>
          </div>
          <p className="field-help">
            Use a clear photo containing only your face. Your selfie is used for
            this search and is not saved.
          </p>
          <label className="check-label">
            <input name="consent" type="checkbox" required disabled={busy} />
            <span>
              I understand Amazon Rekognition will process these photos and my
              selfie, and I have permission to use them for this search.
            </span>
          </label>
          <p className="field-help">
            Amazon Rekognition processes the collection and reference photo.
            Face indexes stay scoped to this search until you delete it.
            Similarity scores are not proof of identity.
          </p>
          <button
            className="button"
            disabled={
              busy ||
              processingActive ||
              Boolean(scan?.deleting) ||
              !capabilities.data?.faceMatching
            }
          >
            <ScanFace size={18} />
            {busy
              ? 'Working...'
              : processingActive
                ? 'Preparing collection...'
                : scan
                  ? 'Search again'
                  : 'Find my photos'}
          </button>
          <ErrorNote error={error} />
          <p role="status">{status}</p>
        </form>
      )}
      {scan?.resultsRetained === false && (
        <section
          className="source-panel"
          aria-labelledby="discover-processing-heading"
        >
          <h2 id="discover-processing-heading">Saved collection processing</h2>
          {processing ? (
            <>
              <p>
                {processing.status.replaceAll('_', ' ')} /{' '}
                {processing.processed} of {processing.total} photos in this
                batch
              </p>
              <progress
                aria-label="Collection processing progress"
                value={processing.processed}
                max={Math.max(1, processing.total)}
              />
              <p>
                {scan.imported} copies prepared; {scan.indexed} photos contain
                indexed faces. Completed copies and indexes are reused on
                resume.
              </p>
              {processingActive ? (
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy || processing.cancelRequested || scan.deleting}
                  onClick={() => void manageProcessing(true)}
                >
                  {processing.cancelRequested
                    ? 'Pausing after this photo...'
                    : 'Pause processing'}
                </button>
              ) : (
                (processing.status !== 'complete' || processing.failed > 0) &&
                !scan.deleting && (
                  <>
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={retryUncertain}
                        disabled={busy}
                        onChange={(event) => {
                          setRetryUncertain(event.target.checked);
                          retryAttempt.current = null;
                        }}
                      />
                      I allow a new paid attempt if a previous provider result
                      is uncertain. Already completed photos are not processed
                      again.
                    </label>
                    <button
                      className="button secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => void manageProcessing(false)}
                    >
                      Resume remaining photos
                    </button>
                  </>
                )
              )}
            </>
          ) : (
            <p>
              The processing request was not accepted. Retry the original
              selection or delete this incomplete search.
            </p>
          )}
          <p>
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => void resume(scan.id)}
            >
              Refresh processing status
            </button>
          </p>
          <p className="field-help">
            Your selfie and match list are not saved. When you reopen this
            collection, upload a fresh selfie. Prepared copies use your storage
            allowance and normal photo retention.
          </p>
        </section>
      )}
      {scan && (
        <section className="source-panel">
          <p>
            {scan.imported} photos prepared; {scan.indexed} contain indexed
            faces. Searching again reuses this index.
          </p>
          {scan.errors.map((message, index) => (
            <p className="error-note" key={index}>
              {message}
            </p>
          ))}
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void remove()}
          >
            <Trash2 size={16} />
            Delete this search session
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={() => {
              setScan(null);
              setMatches([]);
              setSearched(false);
              attempt.current = null;
              retryAttempt.current = null;
              setError(null);
              setStatus(
                'Choose another collection. Saved processing continues in the background.',
              );
            }}
          >
            Choose another collection
          </button>
        </section>
      )}
      {searched && (
        <section>
          <h2>Your likely matches</h2>
          {matches.length ? (
            <>
              <p>
                Highest similarity first. Review the photos before sharing them.
              </p>
              <PhotoGrid
                readOnly
                preserveOrder
                photos={matches.map((match) => ({
                  id: match.photoId,
                  filename: match.filename,
                  createdAt: scan?.createdAt ?? new Date().toISOString(),
                  bytes: 0,
                  width: match.width ?? 1,
                  height: match.height ?? 1,
                }))}
              />
            </>
          ) : (
            <p>
              No likely matches were found. Try a clearer reference photo; no
              need to index again.
            </p>
          )}
        </section>
      )}
    </>
  );
}
