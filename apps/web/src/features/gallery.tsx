import {
  CloudSources,
  FolderUpload,
  eventOpen,
  restoredImportContext,
} from './sources';
import { Link, useSearchParams } from 'react-router';
import { useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  CloudUpload,
  FolderOpen,
  Image as ImageIcon,
  LockKeyhole,
  Plus,
  X,
} from 'lucide-react';
import { api, type Capabilities, type ImportJob } from '../api';
import { useLibrary } from '../hooks';
import { ErrorNote, Loading, PageTitle, errorMessage } from '../components/ui';

import { PhotoGrid } from '../components/photo-grid';
import { SavedUploadQueue } from './saved-upload-queue';
export { PhotoGrid } from '../components/photo-grid';

export function UploadBox({
  eventId,
  onComplete,
  remainingUploads,
}: {
  eventId?: string;
  onComplete?: () => void;
  remainingUploads?: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueBusy, setQueueBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [retryFiles, setRetryFiles] = useState<File[]>([]);
  const [drag, setDrag] = useState(false);
  const client = useQueryClient();
  const library = useLibrary();
  const destination = library.data?.events.find(
    (event) => event.id === eventId,
  );
  const destinationReady =
    Boolean(library.data) &&
    (!eventId || Boolean(destination && eventOpen(destination)));
  const remaining = Math.max(
    0,
    remainingUploads ??
      (library.data?.photoLimit ?? 20) -
        (library.data?.storedPhotoCount ?? library.data?.photos.length ?? 0),
  );
  async function upload(files: File[], retry = false) {
    if (busy || queueBusy) return;
    if (!destinationReady) {
      setErrors([
        'This destination is unavailable or expired. No photos were uploaded.',
      ]);
      return;
    }
    setBusy(true);
    setErrors([]);
    const failures: string[] = [];
    const failedFiles: File[] = [];
    if (!retry && files.length > remaining)
      failures.push(
        `Only the first ${remaining} photos will be uploaded to stay within this destination's remaining capacity.`,
      );
    const candidates = retry ? files : files.slice(0, remaining);
    for (const [index, file] of candidates.entries()) {
      setProgress(
        `Uploading ${index + 1} of ${candidates.length}: ${file.name}`,
      );
      try {
        if (destination && !eventOpen(destination))
          throw new Error(
            'This event has expired. No more photos can be uploaded.',
          );
        if (
          !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
          file.size > 8 * 1024 * 1024
        )
          throw new Error('Choose JPEG, PNG, or WebP under 8 MB.');
        await api('/photos' + (eventId ? `?eventId=${eventId}` : ''), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-File-Name': encodeURIComponent(file.name),
          },
          body: file,
        });
      } catch (failure) {
        failures.push(`${file.name}: ${errorMessage(failure)}`);
        if (
          ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) &&
          file.size <= 8 * 1024 * 1024
        )
          failedFiles.push(file);
      }
    }
    setErrors(failures);
    setRetryFiles(failedFiles);
    setProgress(
      candidates.length ? 'Upload batch finished.' : 'No photos uploaded.',
    );
    setBusy(false);
    if (input.current) input.current.value = '';
    await client.invalidateQueries({ queryKey: ['library'] });
    await client.invalidateQueries({ queryKey: ['event-gallery', eventId] });
    if (!failures.length && candidates.length) onComplete?.();
  }
  return (
    <div className="upload-area">
      <div
        className={drag ? 'dropzone dragging' : 'dropzone'}
        onDragOver={(event) => {
          event.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDrag(false);
          if (!busy && !queueBusy)
            void upload(Array.from(event.dataTransfer.files));
        }}
      >
        <CloudUpload size={32} strokeWidth={1.4} />
        <h3>
          {eventId
            ? 'Add photos to this event.'
            : 'A home for your photographs.'}
        </h3>
        <p>Drop photos here or choose them from your device.</p>
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          className="visually-hidden"
          aria-label="Choose photos"
          disabled={busy || queueBusy || remaining === 0 || !destinationReady}
          onChange={(event) =>
            void upload(Array.from(event.target.files ?? []))
          }
        />
        <button
          className="button secondary"
          disabled={busy || queueBusy || remaining === 0 || !destinationReady}
          onClick={() => input.current?.click()}
        >
          <Plus size={17} />
          {busy ? 'Uploading...' : 'Choose photos'}
        </button>
        <span className="field-help">
          {remaining} spaces remaining. JPEG, PNG, WebP. Up to 8 MB each.
        </span>
      </div>
      <p className="field-help">
        Uploads are optimized to JPEG, up to 3200 pixels. Location and other
        embedded metadata are removed. Keep your originals separately.
      </p>
      <p role="status" className="upload-status">
        {progress}
      </p>
      {!!retryFiles.length && (
        <>
          {remaining === 0 && (
            <p className="field-help">
              Retry can recover an upload whose reply was lost. Files that were
              not stored still need free space.
            </p>
          )}
          <button
            className="button secondary upload-retry"
            disabled={busy || queueBusy || !destinationReady}
            onClick={() => void upload(retryFiles, true)}
          >
            Retry {retryFiles.length} failed upload
            {retryFiles.length === 1 ? '' : 's'}
          </button>
        </>
      )}
      {errors.map((error) => (
        <p role="alert" className="error-note" key={error}>
          {error}
        </p>
      ))}
      <button
        className="button secondary"
        disabled={busy}
        aria-expanded={queueOpen}
        onClick={() => setQueueOpen(!queueOpen)}
      >
        {queueOpen ? 'Close saved upload queue' : 'Use saved upload queue'}
      </button>
      {queueOpen && (
        <SavedUploadQueue
          eventId={eventId}
          available={destinationReady}
          onBusy={setQueueBusy}
        />
      )}
    </div>
  );
}

export function LibraryPage() {
  const query = useLibrary();
  const personalPhotos =
    query.data?.photos.filter((photo) => !photo.eventId) ?? [];
  const [upload, setUpload] = useState(false);
  return (
    <>
      <PageTitle
        eyebrow="YOUR PERSONAL COLLECTION"
        title="All the good moments."
      >
        <button className="button" onClick={() => setUpload(!upload)}>
          {upload ? <X size={18} /> : <Plus size={18} />}
          {upload ? 'Close upload' : 'Add photos'}
        </button>
      </PageTitle>
      <p className="page-description">
        A little space for your photographs. Browse, select, and take your
        favorites with you.
      </p>
      {upload && <UploadBox onComplete={() => setUpload(false)} />}
      <div className="collection-meta">
        <span>
          <ImageIcon size={16} />
          {query.data
            ? `${personalPhotos.length} photographs`
            : 'Your photographs'}
        </span>
        <span>
          <LockKeyhole size={14} />
          Your personal collection. Event photos stay in their event.
        </span>
      </div>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <>
          <ErrorNote error={query.error} />
          <button
            className="button secondary"
            onClick={() => void query.refetch()}
          >
            Try again
          </button>
        </>
      ) : (
        <PhotoGrid photos={personalPhotos} privateNotes />
      )}
    </>
  );
}

export function ImportPage() {
  const [params] = useSearchParams();
  const [restored] = useState(() => restoredImportContext(params));
  const eventId = params.get('eventId') ?? restored?.eventId ?? '';
  const capabilities = useQuery({
    queryKey: ['capabilities'],
    queryFn: () => api<Capabilities>('/capabilities'),
  });
  const library = useLibrary();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ job: ImportJob }>('/imports/drive', {
        method: 'POST',
        body: JSON.stringify({ url: form.get('url') }),
      });
      setJob(result.job);
      await client.invalidateQueries({ queryKey: ['library'] });
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageTitle
        eyebrow="BRING THE MOMENTS TOGETHER"
        title={eventId ? 'Add to your event.' : 'A fresh perspective.'}
      />
      <p className="page-description">
        {eventId ? (
          <>
            All uploads on this page go to this event.{' '}
            <Link to={'/app/events/' + eventId}>Back to event</Link>.{' '}
          </>
        ) : (
          'Upload from your device or select photos from a connected cloud account. '
        )}
        Your library currently supports {library.data?.photoLimit ?? 20} photos.
      </p>
      <UploadBox {...(eventId ? { eventId } : {})} />
      <FolderUpload {...(eventId ? { destinationEventId: eventId } : {})} />
      <CloudSources {...(eventId ? { destinationEventId: eventId } : {})} />
      {!eventId && !capabilities.data?.cloudImports && (
        <div className="source-panel">
          <FolderOpen size={26} />
          <h2>From Google Drive</h2>
          <div>
            <p>
              Import a single batch from an accessible shared folder. No
              subfolders or additional pages are scanned. Read-only access means
              your Drive files stay unchanged. We never save results back to
              Drive.
            </p>
            {!capabilities.data?.drive && (
              <p className="notice">
                Google Drive connection is unavailable right now. You can still
                upload photos directly from your device.
              </p>
            )}
            {capabilities.data?.driveOAuth &&
              !capabilities.data.driveConnected && (
                <p className="notice">
                  Connect Google Drive, then import a folder that account can
                  open.
                </p>
              )}
            {capabilities.data?.driveOAuth && (
              <p>
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (capabilities.data.driveConnected) {
                      void api('/drive', { method: 'DELETE' })
                        .then(() => capabilities.refetch())
                        .catch(setError);
                      return;
                    }
                    void api<{ url: string }>('/drive/connect', {
                      method: 'POST',
                    })
                      .then((result) => window.location.assign(result.url))
                      .catch(setError);
                  }}
                >
                  {capabilities.data.driveConnected
                    ? 'Disconnect Google Drive'
                    : 'Connect Google Drive'}
                </button>
              </p>
            )}
            <ErrorNote error={capabilities.error} />
            <form onSubmit={(event) => void submit(event)}>
              <label>
                Google Drive folder link
                <input
                  name="url"
                  type="url"
                  required
                  placeholder="https://drive.google.com/drive/folders/..."
                />
              </label>
              <button
                className="button secondary"
                disabled={busy || !capabilities.data?.driveConnected}
              >
                {busy
                  ? 'Importing your batch...'
                  : `Import up to ${capabilities.data?.photoLimit ?? 20} photos`}
                <ArrowRight size={16} />
              </button>
            </form>
            <ErrorNote error={error} />
            {job && (
              <div role="status">
                <p>
                  Import {job.state}: {job.imported} photos imported.
                </p>
                {job.errors.map((text) => (
                  <p className="error-note" key={text}>
                    {text}
                  </p>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {!eventId &&
        !capabilities.data?.cloudImports &&
        !!library.data?.jobs.length && (
          <section className="job-history">
            <h2>Import history</h2>
            {library.data.jobs.map((item) => (
              <article key={item.id}>
                <span>{new Date(item.createdAt).toLocaleString()}</span>
                <strong>{item.state}</strong>
                <span>{item.imported} imported</span>
                {item.errors.map((error) => (
                  <p key={error}>{error}</p>
                ))}
              </article>
            ))}
          </section>
        )}
    </>
  );
}
