import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Pause, Play, RefreshCw } from 'lucide-react';
import { api, HttpError } from '../api';
import { ErrorNote } from '../components/ui';
import './saved-imports.css';

interface SavedImport {
  id: string;
  importId: string;
  source: string;
  status: string;
  total: number;
  imported: number;
  processed: number;
  failed: number;
  cancelRequested: boolean;
  errors: string[];
  canResume?: boolean;
}
const labels: Record<string, string> = {
  queued: 'Queued',
  running: 'Importing',
  complete: 'Complete',
  partial: 'Needs attention',
  failed: 'Stopped',
  cancelled: 'Paused',
  interrupted: 'Interrupted',
};
const resumable = new Set(['partial', 'failed', 'cancelled', 'interrupted']);
export function SavedCloudImports({
  enabled,
  eventId,
}: {
  enabled: boolean;
  eventId?: string;
}) {
  const client = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState<unknown>(null);
  const [confirmFor, setConfirmFor] = useState<string | null>(null),
    [confirmed, setConfirmed] = useState(false);
  const requests = useRef(
    new Map<string, { generation: string; id: string }>(),
  );
  const imports = useQuery({
    queryKey: ['cloud-imports', eventId ?? 'personal'],
    enabled,
    queryFn: () =>
      api<{ jobs: SavedImport[] }>(
        '/imports/queued' +
          (eventId ? '?eventId=' + encodeURIComponent(eventId) : ''),
      ),
    refetchInterval: (query) =>
      query.state.data?.jobs.some((job) =>
        ['queued', 'running'].includes(job.status),
      )
        ? 5000
        : false,
  });
  const terminal =
    imports.data?.jobs
      .filter((job) => !['queued', 'running'].includes(job.status))
      .map((job) => job.id + ':' + job.status + ':' + job.imported)
      .join('|') ?? '';
  useEffect(() => {
    if (enabled && terminal) {
      void client.invalidateQueries({ queryKey: ['library'] });
      void client.invalidateQueries({ queryKey: ['event-gallery', eventId] });
    }
  }, [client, enabled, terminal, eventId]);
  async function act(job: SavedImport, action: 'pause' | 'resume') {
    setBusy(job.id);
    setError(null);
    try {
      if (action === 'pause')
        await api('/imports/queued/' + job.id + '/pause', { method: 'POST' });
      else {
        const access = await api<{ generation: string }>(
          '/imports/queued/connection/' + job.source,
        );
        let request = requests.current.get(job.id);
        if (
          confirmFor === job.id &&
          confirmed &&
          request?.generation !== access.generation
        ) {
          requests.current.set(job.id, {
            generation: access.generation,
            id: crypto.randomUUID(),
          });
          throw new HttpError(
            409,
            'Your source account changed again. Confirm the current account before resuming.',
            'SOURCE_CONNECTION_CHANGED',
          );
        }
        if (!request || request.generation !== access.generation) {
          request = { generation: access.generation, id: crypto.randomUUID() };
          requests.current.set(job.id, request);
        }
        await api('/imports/queued/' + job.id + '/resume', {
          method: 'POST',
          headers: { 'X-PicFind-Consent': 'cloud-import-v1' },
          body: JSON.stringify({
            requestId: request.id,
            generation: request.generation,
            acceptConnectionChange: confirmFor === job.id && confirmed,
          }),
        });
        requests.current.delete(job.id);
        setConfirmFor(null);
        setConfirmed(false);
      }
      await imports.refetch();
      await client.invalidateQueries({ queryKey: ['library'] });
    } catch (failure) {
      setError(failure);
      if (
        failure instanceof HttpError &&
        failure.code === 'SOURCE_CONNECTION_CHANGED'
      ) {
        setConfirmFor(job.id);
        setConfirmed(false);
      }
    } finally {
      setBusy(null);
    }
  }
  if (!enabled) return null;
  return (
    <section className="saved-imports" aria-labelledby="saved-imports-title">
      <div className="saved-imports-heading">
        <div>
          <h3 id="saved-imports-title">Saved cloud imports</h3>
          <p>
            Close this tab if you need to. Saved imports continue on the server,
            without running face matching.
          </p>
        </div>
        <button
          className="button secondary"
          disabled={imports.isFetching}
          onClick={() => void imports.refetch()}
          aria-label="Refresh saved imports"
        >
          <RefreshCw size={16} /> Refresh
        </button>
      </div>
      <ErrorNote error={imports.error ?? error} />
      {imports.isPending && <p role="status">Loading saved imports...</p>}
      {imports.data?.jobs.length === 0 && (
        <p className="field-help">
          Your queued imports will appear here after you select and confirm
          photos above.
        </p>
      )}
      <div className="saved-import-list">
        {imports.data?.jobs.map((job) => (
          <article
            className="saved-import-card"
            key={job.id}
            aria-label={job.source + ' import'}
          >
            <div className="saved-import-summary">
              <strong>
                {job.source === 'onedrive'
                  ? 'OneDrive'
                  : job.source === 'dropbox'
                    ? 'Dropbox'
                    : job.source === 'drive'
                      ? 'Google Drive'
                      : 'Box'}
              </strong>
              <span>
                {job.cancelRequested && job.status === 'running'
                  ? 'Pausing after current photo'
                  : (labels[job.status] ?? job.status)}
              </span>
            </div>
            <p>
              {job.imported} of {job.total} photos in{' '}
              {eventId ? 'this event' : 'your personal library'}
            </p>
            <progress
              value={Math.min(job.imported, job.total)}
              max={Math.max(1, job.total)}
              aria-label="Imported photos"
            />
            {job.errors.map((message, index) => (
              <p className="field-help" key={index}>
                {message}
              </p>
            ))}
            {confirmFor === job.id && (
              <label className="saved-import-confirm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                I confirm the reconnected source account contains the same
                selected photos, and I want PicFind to continue this import.
              </label>
            )}
            <div className="source-actions">
              {['queued', 'running'].includes(job.status) && (
                <button
                  className="button secondary"
                  disabled={busy !== null || job.cancelRequested}
                  onClick={() => void act(job, 'pause')}
                >
                  <Pause size={15} /> Pause import
                </button>
              )}
              {resumable.has(job.status) && job.canResume !== false && (
                <button
                  className="button secondary"
                  disabled={
                    busy !== null || (confirmFor === job.id && !confirmed)
                  }
                  onClick={() => void act(job, 'resume')}
                >
                  <Play size={15} /> Resume missing photos
                </button>
              )}
              {job.imported > 0 && (
                <Link
                  to={eventId ? '/app/events/' + eventId : '/app/library'}
                  className="text-link"
                >
                  {eventId ? 'Open event gallery' : 'Open photo library'}
                </Link>
              )}
            </div>
            {resumable.has(job.status) && job.canResume === false && (
              <p className="field-help">
                The person who connected this source can resume it. You can
                still manage the event's imported photos.
              </p>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
