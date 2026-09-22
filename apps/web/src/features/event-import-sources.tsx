import { useState } from 'react';
import { useParams } from 'react-router';
import { CloudDownload, FolderOpen } from 'lucide-react';
import { CloudSources } from './sources';
import { SavedCloudImports } from './saved-imports';
import { EventFolderSyncs } from './event-folder-syncs';
import { useQuery } from '@tanstack/react-query';
import { api, type Capabilities } from '../api';
import { ErrorNote } from '../components/ui';

const providers = [
  ['drive', 'Google Drive'],
  ['dropbox', 'Dropbox'],
  ['onedrive', 'OneDrive'],
  ['box', 'Box'],
] as const;
export function EventImportSources() {
  const params = useParams();
  const eventId = params.id ?? params.eventId;
  const [source, setSource] = useState<(typeof providers)[number][0] | null>(
    null,
  );
  const capabilities = useQuery({
    queryKey: ['capabilities'],
    queryFn: () => api<Capabilities>('/capabilities'),
  });
  const connections = useQuery({
    queryKey: ['sources'],
    queryFn: () =>
      api<{
        sources: {
          id: string;
          configured: boolean;
          connected: boolean;
          reconnectRequired?: boolean;
        }[];
      }>('/sources'),
    retry: false,
  });
  if (!eventId) return null;
  return (
    <section
      className="event-import-sources"
      aria-label="Add photos to this event"
    >
      <div className="saved-imports-heading">
        <div>
          <h3>One event. Its own photo collection.</h3>
          <p>
            Use the device uploader or import from a connected cloud account.
            Photos stay in this event, never in another gallery.
          </p>
        </div>
        <FolderOpen size={24} aria-hidden="true" />
      </div>
      <p className="field-help">
        Choose a source below. Opening a browser does not start an import or
        face processing.
      </p>
      <ErrorNote error={capabilities.error ?? connections.error} />
      {(capabilities.error || connections.error) && (
        <button
          className="button secondary"
          onClick={() => {
            void capabilities.refetch();
            void connections.refetch();
          }}
        >
          Refresh source status
        </button>
      )}
      <div className="event-source-grid">
        {providers.map(([id, label]) => {
          const loading =
            id === 'drive' ? capabilities.isPending : connections.isPending;
          const failed =
            id === 'drive' ? capabilities.isError : connections.isError;
          const connection =
            id === 'drive'
              ? {
                  configured:
                    capabilities.data?.driveOAuth &&
                    capabilities.data?.cloudImports,
                  connected: capabilities.data?.driveConnected,
                  reconnectRequired: false,
                }
              : connections.data?.sources?.find((item) => item.id === id);
          const ready = !loading && !failed && connection?.configured;
          const connected =
            ready && connection.connected && !connection.reconnectRequired;
          const status = loading
            ? 'Checking connection'
            : failed
              ? 'Status unavailable'
              : !ready
                ? 'Not available yet'
                : connection.reconnectRequired
                  ? 'Reconnect needed'
                  : connected
                    ? 'Connected'
                    : 'Not connected';
          return (
            <article
              className={`event-source-card${source === id ? ' is-selected' : ''}`}
              key={id}
            >
              <div className="event-source-card-heading">
                <CloudDownload size={22} aria-hidden="true" />
                <span
                  className={`source-status${connected ? ' connected' : ''}`}
                >
                  {status}
                </span>
              </div>
              <h4>{label}</h4>
              <p>
                {ready
                  ? 'Copy selected photos into this event. Your source files are unchanged.'
                  : 'Use device upload while this source is unavailable. No account connection is required for device uploads.'}
              </p>
              <button
                className="button secondary"
                aria-pressed={source === id}
                aria-expanded={source === id}
                aria-controls="event-cloud-browser"
                disabled={!ready && source !== id}
                onClick={() => setSource(source === id ? null : id)}
              >
                {source === id
                  ? 'Close browser'
                  : connected
                    ? 'Import now'
                    : ready
                      ? 'Set up import'
                      : 'Unavailable'}
                <span className="visually-hidden"> from {label}</span>
              </button>
            </article>
          );
        })}
      </div>
      {source ? (
        <div
          id="event-cloud-browser"
          className="event-cloud-browser"
          role="region"
          aria-label="Selected cloud source"
        >
          <CloudSources
            key={eventId + ':' + source}
            destinationEventId={eventId}
            initialSource={source}
          />
        </div>
      ) : (
        <SavedCloudImports
          enabled={capabilities.data?.cloudImports === true}
          eventId={eventId}
        />
      )}
      <EventFolderSyncs
        eventId={eventId}
        enabled={capabilities.data?.folderSyncManagement === true}
      />
    </section>
  );
}
