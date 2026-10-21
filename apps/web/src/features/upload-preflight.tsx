import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { ErrorNote } from '../components/ui';
import './upload-preflight.css';
import type { UploadQueue } from '../../../../packages/shared/src/upload-queue';
import {
  PREFLIGHT_ACTOR,
  preflightCommand,
  preflightReport,
  type PreflightReport,
} from '../../../../packages/shared/src/upload-preflight';

export function UploadPreflight({
  queue,
  disabled,
}: {
  queue: UploadQueue;
  disabled: boolean;
}) {
  const items = queue.items
    .filter((item) => !['complete', 'cancelled'].includes(item.status))
    .map(({ id, digest, size }) => ({ id, digest, size }));
  const binding = JSON.stringify([
    queue.accountId,
    queue.eventId,
    queue.id,
    queue.revision,
    items,
  ]);
  return (
    <Inspection
      key={binding}
      accountId={queue.accountId}
      eventId={queue.eventId}
      items={items}
      disabled={disabled || items.length === 0}
    />
  );
}

function Inspection({
  accountId,
  eventId,
  items,
  disabled,
}: {
  accountId: string;
  eventId: string | null;
  items: { id: string; digest: string; size: number }[];
  disabled: boolean;
}) {
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (disabled) {
      pending.current?.abort();
      pending.current = null;
      setBusy(false);
      setReport(null);
      setError(null);
    }
  }, [disabled]);
  async function inspect() {
    if (disabled || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setReport(null);
    setError(null);
    try {
      const command = preflightCommand.parse({
        requestId: crypto.randomUUID(),
        eventId,
        items,
      });
      const result = preflightReport.parse(
        await api('/photos/preflight', {
          method: 'POST',
          signal: controller.signal,
          headers: { [PREFLIGHT_ACTOR]: accountId },
          body: JSON.stringify(command),
        }),
      );
      controller.signal.throwIfAborted();
      if (
        result.accountId !== accountId ||
        result.eventId !== eventId ||
        result.requestId !== command.requestId ||
        result.items.length !== items.length ||
        result.items.some(
          (item, index) =>
            item.id !== items[index]!.id ||
            item.inputBytes !== items[index]!.size,
        )
      )
        throw new Error(
          'The batch check no longer matches this account and queue. Check again.',
        );
      setReport(result);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (pending.current === controller) pending.current = null;
    }
  }
  return (
    <section
      className="stack upload-preflight"
      aria-label="Upload batch preflight"
    >
      <h4>Check before uploading</h4>
      <p>
        Check unfinished file fingerprints against this destination without
        uploading images or changing saved progress. Event capacity checks are
        available to the event owner.
      </p>
      <div className="toolbar">
        <button
          type="button"
          className="button secondary"
          disabled={disabled || busy}
          onClick={() => void inspect()}
        >
          {busy ? 'Checking batch...' : 'Check batch capacity'}
        </button>
        {busy && (
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              pending.current?.abort();
              pending.current = null;
              setBusy(false);
            }}
          >
            Cancel batch check
          </button>
        )}
      </div>
      {!disabled && <ErrorNote error={error} />}
      {!disabled && report && (
        <div className="stack" aria-label="Batch capacity report">
          <p role="status">
            {report.photoSlotsFit
              ? 'Current photo slots fit this batch.'
              : 'This batch may exceed current photo slots.'}
          </p>
          <dl>
            <dt>Exact-input uploads available to recover</dt>
            <dd>{report.reusable}</dd>
            <dt>Files that may need new slots</dt>
            <dd>{report.newCandidates}</dd>
            <dt>Library photo slots remaining</dt>
            <dd>{report.librarySlotsRemaining}</dd>
            {report.eventSlotsRemaining !== null && (
              <>
                <dt>Event photo slots remaining</dt>
                <dd>{report.eventSlotsRemaining}</dd>
              </>
            )}
            <dt>Selected original bytes</dt>
            <dd>{report.inputBytes.toLocaleString()}</dd>
            <dt>Original bytes for new candidates</dt>
            <dd>{report.newInputBytes.toLocaleString()}</dd>
          </dl>
          <p>Checked {new Date(report.checkedAt).toLocaleString()}.</p>
          <p>
            This is a snapshot, not a reservation. Final stored bytes and paid
            storage allowance have not been verified. Image validation,
            processed-image duplicate checks and current upload permissions
            still apply. Reselect originals to recover unacknowledged uploads.
          </p>
        </div>
      )}
    </section>
  );
}
