import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { CheckCircle2, Clock3, PauseCircle, ScanFace } from 'lucide-react';
import { api } from '../api';
import { ErrorNote } from '../components/ui';
import './processing.css';

interface ProcessingJob {
  id: string;
  requestId?: string;
  eventId: string;
  status:
    | 'queued'
    | 'running'
    | 'complete'
    | 'partial'
    | 'failed'
    | 'cancelled'
    | 'interrupted';
  total: number;
  processed: number;
  indexed: number;
  empty: number;
  failed: number;
  cancelRequested: boolean;
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
}
const active = (job: ProcessingJob) =>
  job.status === 'queued' || job.status === 'running';
const labels: Record<ProcessingJob['status'], string> = {
  queued: 'Waiting to start',
  running: 'Preparing face search',
  complete: 'Processing complete',
  partial: 'Some photos need attention',
  failed: 'Processing needs attention',
  cancelled: 'Processing stopped',
  interrupted: 'Interrupted, not automatically repeated',
};
export function EventProcessing({
  eventId,
  photoCount,
  archived,
}: {
  eventId: string;
  photoCount: number;
  archived: boolean;
}) {
  const client = useQueryClient();
  const [consent, setConsent] = useState(false),
    [retryUncertain, setRetryUncertain] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  const attempt = useRef<string | null>(null);
  const attemptRetry = useRef(false);
  const refreshed = useRef<string | null>(null);
  const query = useQuery({
    queryKey: ['event-processing', eventId],
    queryFn: () =>
      api<{
        enabled: boolean;
        jobs: ProcessingJob[];
        deleting?: boolean;
        retryUncertainRequired?: boolean;
      }>(`/events/${eventId}/processing`),
    refetchInterval: (state) =>
      state.state.data?.jobs.some(active) ? 1500 : false,
  });
  const current = query.data?.jobs.find(active),
    latest = current ?? query.data?.jobs[0];
  const retryRequired = Boolean(query.data?.retryUncertainRequired);
  const deleting = Boolean(query.data?.deleting);
  useEffect(() => {
    attempt.current = null;
    attemptRetry.current = false;
    refreshed.current = null;
    setConsent(false);
    setRetryUncertain(false);
    setError(null);
  }, [eventId]);
  useEffect(() => {
    if (latest && !active(latest) && refreshed.current !== latest.id) {
      refreshed.current = latest.id;
      void client.invalidateQueries({ queryKey: ['library'] });
      void client.invalidateQueries({ queryKey: ['event-insights', eventId] });
    }
  }, [latest, client, eventId]);
  useEffect(() => {
    if (query.data?.jobs.some((job) => job.requestId === attempt.current)) {
      attempt.current = null;
      setError(null);
      setConsent(false);
      setRetryUncertain(false);
    }
  }, [query.data]);
  async function start() {
    if (
      !consent ||
      busy ||
      current ||
      archived ||
      deleting ||
      (retryRequired && !retryUncertain) ||
      !photoCount ||
      !query.data?.enabled
    )
      return;
    setBusy(true);
    setError(null);
    const authorizeRetry = retryRequired && retryUncertain;
    if (attemptRetry.current !== authorizeRetry) attempt.current = null;
    attemptRetry.current = authorizeRetry;
    attempt.current ??= crypto.randomUUID();
    try {
      await api<{ job: ProcessingJob }>(`/events/${eventId}/index-faces`, {
        method: 'POST',
        headers: { 'X-PicFind-Consent': 'face-matching-v1' },
        body: JSON.stringify({
          requestId: attempt.current,
          retryUncertain: authorizeRetry,
        }),
      });
      attempt.current = null;
      setConsent(false);
      setRetryUncertain(false);
    } catch (failure) {
      setError(failure);
    } finally {
      await client.invalidateQueries({
        queryKey: ['event-processing', eventId],
      });
      setBusy(false);
    }
  }
  async function cancel() {
    if (!current || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/processing/jobs/${current.id}/cancel`, { method: 'POST' });
    } catch (failure) {
      setError(failure);
    } finally {
      await client.invalidateQueries({
        queryKey: ['event-processing', eventId],
      });
      setBusy(false);
    }
  }
  return (
    <section className="processing-panel" aria-label="Event face processing">
      <div className="processing-heading">
        <ScanFace size={22} />
        <div>
          <h3>Prepare once. Let guests find their moments.</h3>
          <p>
            Progress is saved on the server. You can leave this page and come
            back.
          </p>
        </div>
      </div>
      <ErrorNote error={error ?? query.error} />
      {deleting && (
        <p className="notice">
          Deletion has started for this event. Finish deletion before preparing
          another gallery; this event cannot be restored.
        </p>
      )}
      {query.error && (
        <button
          type="button"
          className="button secondary compact"
          onClick={() => void query.refetch()}
        >
          Retry processing status
        </button>
      )}
      {!query.isPending && !query.error && !query.data?.enabled && (
        <p className="notice">
          Background face processing is not available on this deployment yet.
          Photo browsing and downloads still work.
        </p>
      )}
      {latest && (
        <div className="processing-progress" role="status" aria-live="polite">
          <div className="processing-status">
            <span>
              {latest.status === 'complete' ? (
                <CheckCircle2 size={17} />
              ) : (
                <Clock3 size={17} />
              )}
              {latest.cancelRequested && active(latest)
                ? 'Finishing the current photo before stopping'
                : labels[latest.status]}
            </span>
            <strong>
              {latest.processed} / {latest.total}
            </strong>
          </div>
          <progress
            aria-label="Photos processed"
            max={Math.max(1, latest.total)}
            value={latest.processed}
          />
          <p>
            {latest.indexed} with searchable faces / {latest.empty} without
            detected faces / {latest.failed} needing attention
          </p>
          {latest.status === 'interrupted' && (
            <p className="notice">
              A provider request may have completed before the interruption.
              PicFind has not repeated it. Starting again reuses saved results,
              but an unresolved photo may incur another processing attempt.
            </p>
          )}
          {latest.failureCode === 'QUOTA_EXHAUSTED' && (
            <p className="notice">
              Your processing allowance or development safety limit was reached.{' '}
              <Link to="/app/billing">Check your allowance</Link> before trying
              again.
            </p>
          )}
          {latest.status === 'cancelled' && (
            <p>
              Completed photos remain searchable. Unstarted photos have not been
              processed.
            </p>
          )}
          {current && (
            <button
              type="button"
              className="button secondary compact"
              disabled={busy || current.cancelRequested}
              onClick={() => void cancel()}
            >
              <PauseCircle size={16} />
              {current.cancelRequested
                ? 'Stopping after current photo'
                : 'Stop processing'}
            </button>
          )}
        </div>
      )}
      {!current && (
        <>
          <label className="consent-line">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
              disabled={archived || deleting || !query.data?.enabled || busy}
            />
            I have permission to process these photos for face matching.
          </label>
          {retryRequired && (
            <div className="processing-retry">
              <p id={`processing-retry-${eventId}`}>
                A previous request may already have processed some photos.
                Retrying unresolved photos can consume your allowance again.
                Saved results will be reused.
              </p>
              <label className="consent-line">
                <input
                  type="checkbox"
                  checked={retryUncertain}
                  aria-describedby={`processing-retry-${eventId}`}
                  disabled={
                    archived || deleting || !query.data?.enabled || busy
                  }
                  onChange={(event) => {
                    setRetryUncertain(event.target.checked);
                    attempt.current = null;
                  }}
                />
                I authorize another processing attempt for these unresolved
                photos.
              </label>
            </div>
          )}
          <p className="field-help">
            {photoCount} photo{photoCount === 1 ? '' : 's'} in this event.
            Already prepared photos are reused. New processing attempts consume
            your allowance; there are no automatic overage charges.
          </p>
          <button
            type="button"
            className="button secondary"
            disabled={
              busy ||
              !consent ||
              !photoCount ||
              archived ||
              deleting ||
              (retryRequired && !retryUncertain) ||
              !query.data?.enabled
            }
            onClick={() => void start()}
          >
            <ScanFace size={16} />
            {busy ? 'Submitting...' : 'Prepare face search'}
          </button>
        </>
      )}
      {query.data && query.data.jobs.length > 1 && (
        <details className="processing-history">
          <summary>Previous processing runs</summary>
          <ul>
            {query.data.jobs
              .filter((job) => job.id !== latest?.id)
              .slice(0, 4)
              .map((job) => (
                <li key={job.id}>
                  <span>{labels[job.status]}</span>
                  <span>
                    {job.processed}/{job.total} photos
                  </span>
                  <time dateTime={job.createdAt}>
                    {new Date(job.createdAt).toLocaleDateString()}
                  </time>
                </li>
              ))}
          </ul>
        </details>
      )}
    </section>
  );
}
