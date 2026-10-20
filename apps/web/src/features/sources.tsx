import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { FolderOpen, CloudDownload } from 'lucide-react';
import { api, HttpError, type Capabilities, type ImportJob } from '../api';
import { ErrorNote } from '../components/ui';
import { useLibrary } from '../hooks';
import './sources.css';
import { SavedCloudImports } from './saved-imports';
import { FolderImport } from './folder-import';
import { FolderSyncSetup } from './event-folder-syncs';

type Source = 'drive' | 'dropbox' | 'onedrive' | 'box';
type Item = { id: string; name: string; folder: boolean; bytes: number };
const labels: Record<Source, string> = {
  drive: 'Google Drive',
  dropbox: 'Dropbox',
  onedrive: 'OneDrive',
  box: 'Box',
};
const returnContextKey = 'picfind:event-import:return';
export function restoredImportContext(params: URLSearchParams) {
  if (!params.has('connected') && !params.has('drive')) return null;
  try {
    const saved = JSON.parse(
      sessionStorage.getItem(returnContextKey) ?? 'null',
    ) as { eventId?: string; source?: Source } | null;
    if (
      saved?.eventId &&
      /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(saved.eventId) &&
      saved.source &&
      Object.keys(labels).includes(saved.source)
    )
      return { eventId: saved.eventId, source: saved.source };
  } catch {
    /* An invalid local hint must never authorize an event import. */
  }
  return null;
}
export function eventOpen(event: { archived?: boolean; expiresAt?: string }) {
  return (
    !event.archived &&
    (!event.expiresAt || Date.parse(event.expiresAt) > Date.now())
  );
}
export function CloudSources({
  destinationEventId,
  initialSource,
}: { destinationEventId?: string; initialSource?: Source } = {}) {
  const [params] = useSearchParams();
  const [restored] = useState(() => restoredImportContext(params));
  const eventId =
    destinationEventId ?? params.get('eventId') ?? restored?.eventId ?? '';
  useEffect(() => {
    if (restored) {
      try {
        sessionStorage.removeItem(returnContextKey);
      } catch {
        /* Optional tab-local routing hint. */
      }
    }
  }, [restored]);
  const [source, setSource] = useState<Source>(
    initialSource ??
      ((['drive', 'dropbox', 'onedrive', 'box'].includes(
        params.get('source') ?? '',
      )
        ? params.get('source')
        : (restored?.source ?? 'dropbox')) as Source),
  );
  const connections = useQuery({
    queryKey: ['sources'],
    queryFn: () =>
      api<{
        sources: {
          id: Source;
          configured: boolean;
          connected: boolean;
          persistent?: boolean;
          reconnectRequired?: boolean;
        }[];
      }>('/sources'),
  });
  const capabilities = useQuery({
    queryKey: ['capabilities'],
    queryFn: () => api<Capabilities>('/capabilities'),
  });
  const library = useLibrary();
  const destination = library.data?.events.find(
    (event) => event.id === eventId,
  );
  const moderator = destination?.accessRole === 'moderator';
  const eventCapacity = useQuery({
    queryKey: ['event-gallery', eventId],
    enabled: Boolean(eventId && moderator),
    queryFn: () =>
      api<{ remainingUploads: number }>(`/events/${eventId}/gallery`),
  });
  const destinationReady =
    (!eventId || Boolean(destination && eventOpen(destination))) &&
    (!moderator ||
      (Boolean(eventCapacity.data) &&
        capabilities.data?.cloudImports === true));
  const client = useQueryClient();
  const [path, setPath] = useState<{ id: string; name: string }[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [browsed, setBrowsed] = useState(false);
  const [driveFolder, setDriveFolder] = useState('');
  const [incomplete, setIncomplete] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [generation, setGeneration] = useState<string | null>(null);
  const [copyConfirmed, setCopyConfirmed] = useState(false);
  const [savedMessage, setSavedMessage] = useState('');
  const savedRequest = useRef<{ key: string; id: string } | null>(null);
  const savedImports = capabilities.data?.cloudImports === true;
  const batchLimit = savedImports
    ? (capabilities.data?.eventIndexMax ?? 20)
    : 20;
  const selectionLimit = Math.max(
    0,
    moderator
      ? Math.min(batchLimit, eventCapacity.data?.remainingUploads ?? 0)
      : Math.min(
          batchLimit,
          (library.data?.photoLimit ?? 20) -
            (library.data?.storedPhotoCount ??
              library.data?.photos.length ??
              0),
          eventId
            ? batchLimit -
                (library.data?.photos.filter(
                  (photo) => photo.eventId === eventId,
                ).length ?? 0)
            : batchLimit,
        ),
  );
  const selectable = items.filter(
    (item) => !item.folder && item.bytes <= 8 * 1024 * 1024,
  );
  const connection =
    source === 'drive'
      ? {
          configured: Boolean(capabilities.data?.driveOAuth),
          connected: Boolean(capabilities.data?.driveConnected),
          persistent: savedImports,
          reconnectRequired: false,
        }
      : connections.data?.sources?.find((item) => item.id === source);
  async function browse(next: typeof path, append = false) {
    setBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams({
        folder: next.at(-1)?.id ?? '',
        ...(append && cursor ? { cursor } : {}),
      });
      const result = await api<{
        items: Item[];
        cursor: string | null;
        generation?: string | null;
        incomplete?: boolean;
      }>(
        source === 'drive'
          ? `/imports/queued/drive/items?${query}`
          : `/sources/${source}/items?${query}`,
      );
      if (
        savedImports &&
        (!result.generation ||
          (append && generation && result.generation !== generation))
      ) {
        setItems([]);
        setSelected([]);
        setCursor(null);
        setGeneration(null);
        throw new Error(
          'Your cloud connection changed. Browse this folder again before choosing photos.',
        );
      }
      setGeneration(result.generation ?? null);
      setIncomplete(result.incomplete ?? false);
      if (!append) setCopyConfirmed(false);
      setItems((previous) => [
        ...new Map(
          (append ? [...previous, ...result.items] : result.items).map(
            (item) => [item.id, item],
          ),
        ).values(),
      ]);
      setBrowsed(true);
      setCursor(result.cursor);
      setPath(next);
      if (!append) setSelected([]);
    } catch (failure) {
      if (
        failure instanceof HttpError &&
        failure.code === 'DRIVE_CURSOR_INVALID'
      ) {
        setItems([]);
        setSelected([]);
        setCursor(null);
        setGeneration(null);
        setCopyConfirmed(false);
      }
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function connect() {
    setBusy(true);
    setError(null);
    try {
      if (connection?.connected) {
        await api(source === 'drive' ? '/drive' : `/sources/${source}`, {
          method: 'DELETE',
        });
        setItems([]);
        setSelected([]);
        setPath([]);
        setCursor(null);
        setGeneration(null);
        setCopyConfirmed(false);
        setBrowsed(false);
        await connections.refetch();
        await capabilities.refetch();
      } else {
        if (eventId && source !== 'drive') {
          // OAuth returns to /app/import; preserve only a routing hint, never credentials.
          // The server still checks ownership and the destination remains locked.
          sessionStorage.setItem(
            returnContextKey,
            JSON.stringify({ eventId, source }),
          );
        }
        const result = await api<{ url: string }>(
          source === 'drive' ? '/drive/connect' : `/sources/${source}/connect`,
          {
            method: 'POST',
            ...(source === 'drive'
              ? {
                  body: JSON.stringify({
                    returnTo: eventId
                      ? '/app/events/' + eventId
                      : '/app/import',
                  }),
                }
              : {}),
          },
        );
        window.location.assign(result.url);
      }
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function importSelected() {
    setBusy(true);
    setError(null);
    try {
      if (!destinationReady)
        throw new Error(
          'This event is unavailable or expired. Return to your event before importing.',
        );
      if (savedImports) {
        if (!generation || !copyConfirmed)
          throw new Error(
            'Confirm permission to copy these photos before importing.',
          );
        const key = JSON.stringify([
          source,
          eventId,
          generation,
          [...selected].sort(),
        ]);
        if (savedRequest.current?.key !== key)
          savedRequest.current = { key, id: crypto.randomUUID() };
        await api('/imports/queued', {
          method: 'POST',
          headers: { 'X-PicFind-Consent': 'cloud-import-v1' },
          body: JSON.stringify({
            provider: source,
            ids: selected,
            generation,
            requestId: savedRequest.current.id,
            ...(eventId ? { eventId } : {}),
          }),
        });
        savedRequest.current = null;
        setSelected([]);
        setCopyConfirmed(false);
        setJob(null);
        setSavedMessage(
          'Import saved. You can leave this page; progress and recovery controls are below.',
        );
        await client.invalidateQueries({ queryKey: ['cloud-imports'] });
        return;
      }
      const result = await api<{ job: ImportJob }>('/imports/source', {
        method: 'POST',
        body: JSON.stringify({
          provider: source,
          ids: selected,
          ...(eventId ? { eventId } : {}),
        }),
      });
      setJob(result.job);
      setSelected([]);
      await client.invalidateQueries({ queryKey: ['library'] });
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="source-panel">
      <CloudDownload size={26} />
      <h2>
        {eventId
          ? 'Import into this event'
          : 'Bring your cloud photos together.'}
      </h2>
      <p className="source-destination">
        {eventId ? (
          <>
            Destination: <strong>{destination?.title ?? 'This event'}</strong>.{' '}
            <Link to={'/app/events/' + eventId}>Back to event</Link>
          </>
        ) : (
          <>
            Destination: <strong>Your personal library</strong>. To add event
            photos, open that event in Studio.
          </>
        )}
      </p>
      {eventId && library.data && !destinationReady && (
        <p className="error-note">
          This event is unavailable or expired. Nothing will be imported into
          your personal library instead.
        </p>
      )}
      <p>
        Choose files from your own account. Connections are read-only and never
        write results back to the source.{' '}
        {connection?.persistent
          ? 'Your connection is encrypted on the server until you disconnect it or delete your account.'
          : 'This deployment keeps connections temporarily in a secure browser cookie.'}
      </p>
      <div className="source-tabs">
        {(Object.keys(labels) as Source[])
          .filter((id) => id !== 'drive' || savedImports)
          .map((id) => (
            <button
              type="button"
              className="button secondary"
              key={id}
              disabled={busy}
              aria-pressed={source === id}
              onClick={() => {
                setSource(id);
                setItems([]);
                setBrowsed(false);
                setPath([]);
                setCursor(null);
                setSelected([]);
                setError(null);
                setJob(null);
                setGeneration(null);
                setCopyConfirmed(false);
                setSavedMessage('');
                setIncomplete(false);
              }}
            >
              {labels[id]}
            </button>
          ))}
      </div>
      {(params.get('connected') === '0' || params.get('drive') === 'error') && (
        <p className="error-note">
          The provider connection did not finish. Please try connecting again.
        </p>
      )}
      {!connection?.configured && (
        <p className="notice">
          {labels[source]} needs its OAuth app configured by the deployment
          owner. You can upload downloaded files below in the meantime.
        </p>
      )}
      <ErrorNote
        error={
          connections.error ??
          capabilities.error ??
          library.error ??
          eventCapacity.error ??
          error
        }
      />
      {connection?.reconnectRequired && (
        <p className="notice">
          Reconnect {labels[source]} to restore access. Your imported photos are
          still in your library.
        </p>
      )}
      <div className="source-actions">
        <button
          className="button secondary"
          disabled={busy || !connection?.configured}
          onClick={() => void connect()}
        >
          {connection?.connected ? 'Disconnect' : 'Connect'} {labels[source]}
        </button>
        {connection?.connected && (
          <button
            className="button"
            disabled={busy || (source === 'drive' && !savedImports)}
            onClick={() => void browse([])}
          >
            Browse photos
          </button>
        )}
      </div>
      {source === 'drive' && savedImports && connection?.connected && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void browse([{ id: driveFolder.trim(), name: 'Linked folder' }]);
          }}
        >
          <label>
            Google Drive folder link
            <input
              type="url"
              required
              value={driveFolder}
              disabled={busy}
              placeholder="https://drive.google.com/drive/folders/..."
              onChange={(event) => setDriveFolder(event.target.value)}
            />
          </label>
          <button
            className="button secondary"
            disabled={busy || !driveFolder.trim()}
          >
            Open Drive folder
          </button>
        </form>
      )}
      {incomplete && (
        <p className="notice">
          Google returned a partial listing. Some photos may be missing; try
          opening a specific subfolder.
        </p>
      )}
      {browsed && (
        <>
          <nav className="source-breadcrumbs" aria-label="Source folders">
            <button disabled={busy} onClick={() => void browse([])}>
              Root
            </button>
            {path.map((folder, index) => (
              <button
                key={folder.id}
                disabled={busy}
                onClick={() => void browse(path.slice(0, index + 1))}
              >
                {folder.name}
              </button>
            ))}
          </nav>
          {!items.length && (
            <p role="status">
              No supported photos or folders here. Choose a parent folder above
              to keep browsing.
            </p>
          )}
          {!!selectable.length && (
            <div className="source-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy || !selectionLimit || !library.data}
                onClick={() => {
                  setSelected(
                    selectable.slice(0, selectionLimit).map((item) => item.id),
                  );
                  setCopyConfirmed(false);
                }}
              >
                Select loaded photos
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={busy || !selected.length}
                onClick={() => {
                  setSelected([]);
                  setCopyConfirmed(false);
                }}
              >
                Clear selection
              </button>
              <span role="status">
                {selected.length} selected / {selectionLimit} available in this
                batch
              </span>
            </div>
          )}
          <div className="source-list">
            {items.map((item) =>
              item.folder ? (
                <button
                  key={item.id}
                  disabled={busy}
                  onClick={() =>
                    void browse([...path, { id: item.id, name: item.name }])
                  }
                >
                  <FolderOpen size={18} />
                  {item.name}
                </button>
              ) : (
                <label key={item.id}>
                  <input
                    type="checkbox"
                    disabled={
                      busy ||
                      item.bytes > 8 * 1024 * 1024 ||
                      (!selected.includes(item.id) &&
                        selected.length >= selectionLimit)
                    }
                    checked={selected.includes(item.id)}
                    onChange={(event) => {
                      setCopyConfirmed(false);
                      setSelected((previous) =>
                        event.target.checked
                          ? [...previous, item.id]
                          : previous.filter((id) => id !== item.id),
                      );
                    }}
                  />
                  {item.name}
                  <small>{(item.bytes / 1024 / 1024).toFixed(1)} MB</small>
                </label>
              ),
            )}
          </div>
        </>
      )}
      {cursor && (
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => void browse(path, true)}
        >
          Load more files
        </button>
      )}
      {savedImports && (
        <label className="saved-import-confirm">
          <input
            type="checkbox"
            checked={copyConfirmed}
            disabled={busy}
            onChange={(event) => setCopyConfirmed(event.target.checked)}
          />
          I have permission to copy the selected photos into PicFind. This
          import does not run face matching.
        </label>
      )}
      <div className="source-actions">
        <button
          className="button"
          disabled={
            busy ||
            !destinationReady ||
            !selected.length ||
            selected.length > selectionLimit ||
            !library.data ||
            Boolean(library.error) ||
            capabilities.isPending ||
            Boolean(capabilities.error) ||
            (savedImports && (!copyConfirmed || !generation))
          }
          onClick={() => void importSelected()}
        >
          {busy ? 'Working...' : `Import ${selected.length} selected`}
        </button>
      </div>
      {savedMessage && <p role="status">{savedMessage}</p>}
      {job && (
        <div role="status">
          <p>
            {job.imported} photos imported. Status: {job.state}.
          </p>
          {job.errors.map((message, index) => (
            <p className="error-note" key={index}>
              {message}
            </p>
          ))}
          <Link to={eventId ? '/app/events/' + eventId : '/app/discover/new'}>
            {eventId
              ? 'Open event gallery'
              : 'Find yourself in imported photos'}
          </Link>
        </div>
      )}
      <p className="field-help">
        JPEG, PNG and WebP, up to 8 MB each; up to {batchLimit.toLocaleString()}{' '}
        photos per selected batch. Subfolders are opened explicitly, not scanned
        automatically.
      </p>
      <SavedCloudImports
        enabled={savedImports && destinationReady}
        {...(eventId ? { eventId } : {})}
      />
      {eventId &&
        destinationReady &&
        capabilities.data?.folderSync &&
        generation &&
        !busy && (
          <FolderSyncSetup
            key={[eventId, source, path.at(-1)?.id, generation].join(':')}
            eventId={eventId}
            provider={source}
            folder={path.at(-1)?.id ?? ''}
            folderName={path.at(-1)?.name ?? ''}
            generation={generation}
          />
        )}
    </section>
  );
}
export function FolderUpload({
  destinationEventId,
}: { destinationEventId?: string } = {}) {
  const [params] = useSearchParams();
  const eventId = destinationEventId ?? params.get('eventId') ?? undefined;
  return <FolderImport {...(eventId ? { eventId } : {})} />;
}
