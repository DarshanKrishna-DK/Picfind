import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { FolderSync, Pause, RefreshCw } from 'lucide-react';
import { api, HttpError } from '../api';
import { ErrorNote } from '../components/ui';
import './event-folder-syncs.css';

type Provider = 'drive' | 'dropbox' | 'onedrive' | 'box';
const names: Record<Provider, string> = {
  drive: 'Google Drive',
  dropbox: 'Dropbox',
  onedrive: 'OneDrive',
  box: 'Box',
};
interface EventSource {
  id: string;
  eventId: string;
  provider: Provider;
  status: 'active' | 'paused' | 'expired' | 'attention';
  imported: number;
  createdAt: string;
  nextCheckAt: string | null;
  expiresAt: string | null;
  sourceOwner: boolean;
  canStop: boolean;
  canResume: boolean;
  folder: string | null;
  error: string | null;
}
const queryKey = (eventId: string) => ['event-folder-sources', eventId];
function useEventSources(eventId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKey(eventId),
    enabled,
    retry: false,
    queryFn: () =>
      api<{ sources: EventSource[] }>(`/events/${eventId}/sources`),
    refetchInterval: enabled ? 15000 : false,
  });
}
export function syncFolderId(provider: Provider, folder: string) {
  if (provider !== 'drive')
    return folder && folder !== 'root' && folder !== '0' && folder !== '/'
      ? folder
      : null;
  if (/^[a-zA-Z0-9_-]+$/.test(folder) && folder !== 'root') return folder;
  try {
    const url = new URL(folder);
    return url.protocol === 'https:' && url.hostname === 'drive.google.com'
      ? (url.pathname.match(
          /^\/drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]+)\/?$/,
        )?.[1] ?? null)
      : null;
  } catch {
    return null;
  }
}
const date = (value: string | null) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleDateString()
    : 'event expiry';

export function EventFolderSyncs({
  eventId,
  enabled,
}: {
  eventId: string;
  enabled: boolean;
}) {
  const query = useEventSources(eventId, enabled),
    client = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [stoppedId, setStoppedId] = useState<string | null>(null);
  async function stop(row: EventSource) {
    setBusy(row.id);
    setStoppedId(row.id);
    setError(null);
    setMessage('');
    try {
      await api(`/events/${eventId}/sources/${row.id}/stop`, {
        method: 'POST',
        body: '{}',
      });
      await client.invalidateQueries({ queryKey: queryKey(eventId) });
      setMessage(
        `${names[row.provider]} syncing stopped. Imported photos remain in this event.`,
      );
    } catch (failure) {
      setError(failure);
      void query.refetch();
    } finally {
      setBusy(null);
    }
  }
  if (!enabled) return null;
  return (
    <section className="folder-sync-panel" aria-label="Event folder syncing">
      <div className="folder-sync-heading">
        <div>
          <h3>Folders that keep this event up to date</h3>
          <p>
            New photos stay in this event. Your original cloud files are never
            changed.
          </p>
        </div>
        <FolderSync aria-hidden="true" size={24} />
      </div>
      <ErrorNote error={query.error ?? error} />
      {message &&
        query.data?.sources.some(
          (row) => row.id === stoppedId && row.status === 'paused',
        ) && <p role="status">{message}</p>}
      {query.isPending ? (
        <p aria-live="polite">Loading event sources...</p>
      ) : query.error ? (
        <button
          className="button secondary"
          onClick={() => void query.refetch()}
        >
          Retry sources
        </button>
      ) : !query.data?.sources.length ? (
        <p className="field-help">
          No folders are syncing. Open a cloud folder above, then choose to keep
          it syncing.
        </p>
      ) : (
        <ul className="folder-sync-list">
          {query.data.sources.map((row) => (
            <li key={row.id}>
              <div>
                <div className="folder-sync-title">
                  <strong>{names[row.provider]}</strong>
                  <span className={`folder-sync-state state-${row.status}`}>
                    {
                      {
                        active: 'Syncing on',
                        paused: 'Stopped',
                        expired: 'Expired',
                        attention: 'Needs attention',
                      }[row.status]
                    }
                  </span>
                </div>
                <p className="folder-sync-path">
                  {row.folder ?? 'Connected by another event contributor'}
                </p>
                <p>
                  {row.imported.toLocaleString()} files processed · Available
                  until {date(row.expiresAt)}
                </p>
                {row.error && (
                  <p className="folder-sync-help">
                    {row.error === 'source-changed'
                      ? 'The connection changed. Stop this source, reconnect and browse the folder again.'
                      : 'Stop this source and review its import history before resuming.'}
                  </p>
                )}
              </div>
              <div className="folder-sync-actions">
                {row.canStop && (
                  <button
                    className="button secondary"
                    disabled={busy !== null}
                    onClick={() => void stop(row)}
                  >
                    <Pause size={15} aria-hidden="true" />
                    {busy === row.id ? 'Stopping...' : 'Stop syncing'}
                  </button>
                )}
                {row.canResume && (
                  <Link
                    className="button secondary"
                    to={`/app/import?eventId=${encodeURIComponent(eventId)}&source=${row.provider}`}
                  >
                    Open folder to resume
                  </Link>
                )}
                {!row.sourceOwner && row.status !== 'expired' && (
                  <small>
                    Only its connected account can resume this source.
                  </small>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function FolderSyncSetup({
  eventId,
  provider,
  folder,
  folderName,
  generation,
}: {
  eventId: string;
  provider: Provider;
  folder: string;
  folderName: string;
  generation: string;
}) {
  const folderId = syncFolderId(provider, folder);
  const query = useEventSources(eventId, Boolean(folderId)),
    client = useQueryClient();
  const [consent, setConsent] = useState(false),
    [replace, setReplace] = useState(false),
    [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [message, setMessage] = useState('');
  const request = useRef<{ key: string; id: string } | null>(null);
  const existing = query.data?.sources.find(
    (row) =>
      row.provider === provider &&
      row.sourceOwner &&
      row.folder === folderId &&
      row.status !== 'expired',
  );
  const active = existing?.status === 'active',
    attention = existing?.status === 'attention';
  async function start() {
    if (!folderId || !consent || (replace && !replaceConfirmed)) return;
    setBusy(true);
    setError(null);
    setMessage('');
    const key = [
      eventId,
      provider,
      folderId,
      generation,
      existing?.id,
      replace,
    ].join(':');
    if (request.current?.key !== key)
      request.current = { key, id: crypto.randomUUID() };
    const resume = existing?.status === 'paused' && !replace;
    try {
      await api(
        `/events/${eventId}/sources${resume ? `/${existing.id}/resume` : ''}`,
        {
          method: 'POST',
          headers: { 'X-PicFind-Consent': 'folder-sync-v1' },
          body: JSON.stringify(
            resume
              ? { requestId: request.current.id, generation }
              : {
                  requestId: request.current.id,
                  provider,
                  folderId,
                  generation,
                  ...(replace && existing
                    ? {
                        replacesSyncId: existing.id,
                        acceptConnectionChange: true,
                      }
                    : {}),
                },
          ),
        },
      );
      await client.invalidateQueries({ queryKey: queryKey(eventId) });
      setMessage(
        'Folder syncing is on. Imports run in the background for this event.',
      );
      setConsent(false);
    } catch (failure) {
      setError(failure);
      if (
        failure instanceof HttpError &&
        failure.code === 'SOURCE_CONNECTION_CHANGED' &&
        existing?.status === 'paused'
      ) {
        setReplace(true);
        setConsent(false);
        setReplaceConfirmed(false);
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="folder-sync-panel folder-sync-setup"
      aria-label="Keep this folder syncing"
    >
      <div className="folder-sync-heading">
        <div>
          <h3>Keep this folder syncing</h3>
          <p>
            {folderId
              ? `Selected folder: ${folderName || folderId}`
              : 'Open a specific folder to enable syncing. Your entire cloud account cannot be selected.'}
          </p>
        </div>
        <RefreshCw size={22} aria-hidden="true" />
      </div>
      {folderId && (
        <>
          <p>
            Copy current photos and check for new files about every 15 minutes,
            until this event expires or you stop syncing. Subfolders are not
            included. Storage and processing use the organizer plan, never guest
            credits.
          </p>
          <ErrorNote error={query.error ?? error} />
          {message && <p role="status">{message}</p>}
          {active ? (
            <p role="status">This folder is already syncing into this event.</p>
          ) : attention ? (
            <p>Stop this source in the event's folder list before resuming.</p>
          ) : (
            <>
              <label className="folder-sync-consent">
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={busy}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                <span>
                  I have permission to keep copying photos from this folder
                  until the event expires or I stop syncing.
                </span>
              </label>
              {replace && (
                <label className="folder-sync-consent">
                  <input
                    type="checkbox"
                    checked={replaceConfirmed}
                    disabled={busy}
                    onChange={(event) =>
                      setReplaceConfirmed(event.target.checked)
                    }
                  />
                  <span>
                    I confirm this reconnected account and folder should replace
                    the stopped source.
                  </span>
                </label>
              )}
              <button
                className="button"
                disabled={
                  busy ||
                  !consent ||
                  query.isPending ||
                  Boolean(query.error) ||
                  (replace && !replaceConfirmed)
                }
                onClick={() => void start()}
              >
                {busy
                  ? 'Saving...'
                  : replace
                    ? 'Replace stopped source'
                    : existing
                      ? 'Resume folder syncing'
                      : 'Start folder syncing'}
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}
