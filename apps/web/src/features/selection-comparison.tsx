import { useEffect, useRef, useState } from 'react';
import type { EventSelection } from '../../../../packages/shared/src/proofing';
import {
  compareSelections,
  filterComparedPhotos,
  type ComparisonFilter,
} from '../../../../packages/shared/src/selection-comparison';
import { exportSelectionFilenames } from '../../../../packages/shared/src/selection-export';
import { api, fileUrl, saveFile } from '../api';
import { ErrorNote } from '../components/ui';
import { MenuSelect } from '../components/menu-select';

export function SelectionComparison({
  eventId,
  selections,
}: {
  eventId: string;
  selections: EventSelection[];
}) {
  const [firstId, setFirstId] = useState('');
  const [secondId, setSecondId] = useState('');
  const [filter, setFilter] = useState<ComparisonFilter>('all');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const first = selections.find((item) => item.id === firstId);
  const second = selections.find((item) => item.id === secondId);
  const comparison =
    first && second && first.id !== second.id
      ? compareSelections(first, second)
      : null;
  const visible = comparison
    ? filterComparedPhotos(comparison.photos, filter)
    : [];
  const options = [
    { value: '', label: 'Choose a request' },
    ...selections.map((selection, index) => ({
      value: selection.id,
      label: `${index + 1}. ${selection.name} (${new Date(selection.createdAt).toLocaleString()})`,
    })),
  ];

  async function exportComparison() {
    if (pending.current || !comparison) return;
    pending.current = true;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      // Reauthorize and recheck retention before producing any downloadable list.
      const current = await api<{ selections: EventSelection[] }>(
        `/events/${eventId}/insights`,
        { signal: abort.signal },
      );
      abort.signal.throwIfAborted();
      const a = current.selections.find((item) => item.id === firstId);
      const b = current.selections.find((item) => item.id === secondId);
      if (!a || !b)
        throw new Error(
          'A request is no longer available. Refresh selections.',
        );
      const latest = compareSelections(a, b);
      const output = exportSelectionFilenames(
        filterComparedPhotos(latest.photos, filter),
        'csv',
      );
      saveFile(
        new Blob([output.content], { type: 'text/csv;charset=utf-8' }),
        `picfind-comparison-${filter}.csv`,
      );
      setMessage(
        `${output.count} filenames exported from current availability.${output.duplicateNames ? ' Some filenames repeat; use photo IDs to distinguish them.' : ''}`,
      );
    } catch (failure) {
      if (!abort.signal.aborted) setError(failure);
    } finally {
      pending.current = false;
      controller.current = null;
      if (!abort.signal.aborted) setBusy(false);
    }
  }

  return (
    <details className="selection-comparison">
      <summary>Compare client selections</summary>
      <p>
        Compare two requests to find shared favorites and differences. Repeated
        submissions are separate requests, even when names match.
      </p>
      <div className="selection-filters">
        <MenuSelect
          label="First selection request"
          value={firstId}
          onChange={(value) => {
            setFirstId(value);
            setMessage('');
            setError(null);
          }}
          disabled={busy}
          options={options}
        />
        <MenuSelect
          label="Second selection request"
          value={secondId}
          onChange={(value) => {
            setSecondId(value);
            setMessage('');
            setError(null);
          }}
          disabled={busy}
          options={options}
        />
      </div>
      {firstId && firstId === secondId && (
        <p className="notice">Choose two different selection requests.</p>
      )}
      {comparison && (
        <>
          <p role="status">
            {comparison.photos.length} available photos, {comparison.shared}{' '}
            shared favorites, {comparison.unavailable} unavailable photos
            omitted.
          </p>
          <MenuSelect
            label="Comparison photos"
            value={filter}
            disabled={busy}
            onChange={(value) => {
              setFilter(value as ComparisonFilter);
              setMessage('');
              setError(null);
            }}
            options={[
              { value: 'all', label: 'All selected photos' },
              { value: 'shared', label: 'Shared favorites' },
              { value: 'first', label: 'Only in first request' },
              { value: 'second', label: 'Only in second request' },
            ]}
          />
          <ul className="comparison-photos" aria-label="Compared photos">
            {visible.map((photo) => (
              <li key={photo.id}>
                <a href={fileUrl(photo.id)} target="_blank" rel="noreferrer">
                  <img
                    src={fileUrl(photo.id)}
                    alt=""
                    width={64}
                    height={64}
                    loading="lazy"
                  />
                  <span>{photo.filename}</span>
                </a>
                <span>
                  {photo.selectedBy === 'both'
                    ? 'Both requests'
                    : photo.selectedBy === 'first'
                      ? 'First request only'
                      : 'Second request only'}
                </span>
              </li>
            ))}
          </ul>
          {!visible.length && <p>No available photos match this comparison.</p>}
          <button
            className="button secondary"
            disabled={busy || !visible.length}
            onClick={() => void exportComparison()}
          >
            {busy ? 'Checking availability...' : 'Export comparison CSV'}
          </button>
          <p className="field-help">
            Exports contain photo IDs and filenames only. Availability is
            checked again on export. Guest names and private notes are excluded.
          </p>
        </>
      )}
      <ErrorNote error={error} />
      <p role="status">{message}</p>
    </details>
  );
}
