import { useEffect, useRef, useState } from 'react';
import { api, HttpError, saveFile } from '../api';
import { ErrorNote } from '../components/ui';
import {
  exportSelectionFilenames,
  type SelectionExportFormat,
} from '../../../../packages/shared/src/selection-export';
import type { ProofingSubmissionState } from '../../../../packages/shared/src/proofing-submission';

export function SubmittedRoundExport({
  root,
  submissionId,
  round,
  disabled,
  refreshAccess,
}: {
  root: string;
  submissionId: string;
  round: number;
  disabled: boolean;
  refreshAccess: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function download(format: SelectionExportFormat) {
    if (pending.current || disabled) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      const latest = await api<ProofingSubmissionState>(root, {
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      const item = [latest.current, ...latest.history].find(
        (candidate) => candidate?.id === submissionId,
      );
      if (!item || item.round !== round)
        throw new Error(
          'This submitted round is no longer available. Refresh submission history.',
        );
      const output = exportSelectionFilenames(
        item.photos.map((photo) => ({
          id: photo.photoId,
          filename: photo.filename,
        })),
        format,
      );
      saveFile(
        new Blob([output.content], {
          type:
            format === 'csv'
              ? 'text/csv;charset=utf-8'
              : 'text/plain;charset=utf-8',
        }),
        `picfind-round-${item.round}-${item.id}.${format}`,
      );
      setMessage(
        `${output.count} ${output.count === 1 ? 'filename' : 'filenames'} exported from submitted round ${item.round}.` +
          (item.unavailableCount > 0
            ? ` ${item.unavailableCount} unavailable ${item.unavailableCount === 1 ? 'photo' : 'photos'} omitted.`
            : '') +
          (output.duplicateNames
            ? ' Some filenames repeat. Use CSV photo IDs to distinguish them.'
            : ''),
      );
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure);
        if (
          failure instanceof HttpError &&
          [401, 403, 404].includes(failure.status)
        )
          await refreshAccess();
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (pending.current === controller) pending.current = null;
    }
  }
  return (
    <div aria-label={`Export submitted round ${round}`}>
      <p>
        Export currently available filenames for this submitted round. CSV
        includes photo IDs to distinguish repeated names.
      </p>
      <button
        className="button secondary"
        disabled={disabled || busy}
        onClick={() => void download('txt')}
      >
        Export round {round} filenames TXT
      </button>
      <button
        className="button secondary"
        disabled={disabled || busy}
        onClick={() => void download('csv')}
      >
        Export round {round} filenames CSV
      </button>
      <ErrorNote error={error} />
      <p role="status">
        {busy ? 'Checking current photo availability...' : message}
      </p>
    </div>
  );
}
