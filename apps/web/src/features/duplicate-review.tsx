import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { saveFile, session } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import {
  duplicateGroups,
  duplicateSummary,
  exportDuplicateReview,
  keepOneDuplicateCopy,
  scanDuplicateFiles,
  setDuplicateKeep,
  type DuplicateRow,
} from '../../../../packages/shared/src/duplicate-review';
import './duplicate-review.css';

export function DuplicateReview() {
  const account = useQuery({
    queryKey: ['session'],
    queryFn: session,
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  if (account.isPending) return <Loading />;
  if (!account.data || account.error)
    return (
      <ErrorNote
        error={
          account.error ?? new Error('Sign in to review local duplicates.')
        }
      />
    );
  return <LocalReview key={account.data.id} />;
}
function LocalReview() {
  const [rows, setRows] = useState<DuplicateRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [duplicatesOnly, setDuplicatesOnly] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<AbortController | null>(null);
  const groups = useMemo(() => duplicateGroups(rows), [rows]);
  const summary = useMemo(() => duplicateSummary(rows), [rows]);
  useEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!rows.length && !busy) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [rows.length, busy]);
  async function scan(files: File[]) {
    if (pending.current || !files.length) return;
    if (
      rows.length &&
      !window.confirm(
        'Replace this local review? Export it first if you need to retain the decisions. Originals remain unchanged.',
      )
    )
      return;
    const controller = new AbortController();
    pending.current = controller;
    setRows([]);
    setBusy(true);
    setError(null);
    setMessage('');
    setProgress({ completed: 0, total: files.length });
    try {
      if (!crypto.subtle)
        throw new Error(
          'This browser cannot use SHA-256 here. Open PicFind in a secure browser context.',
        );
      const result = await scanDuplicateFiles(
        files,
        controller.signal,
        (completed) => setProgress({ completed, total: files.length }),
        (bytes) => crypto.subtle.digest('SHA-256', bytes),
      );
      controller.signal.throwIfAborted();
      setRows(result);
      setMessage(
        'Review ready. Every file is initially kept. Originals remain unchanged.',
      );
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure);
        setProgress({ completed: 0, total: 0 });
      }
    } finally {
      files.length = 0;
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  function cancel() {
    pending.current?.abort();
    setMessage(
      'Scan cancelled. No partial review was retained. Originals remain unchanged.',
    );
  }
  function clear() {
    if (
      pending.current ||
      !window.confirm(
        'Discard this local review and its decisions? Originals remain unchanged.',
      )
    )
      return;
    setRows([]);
    setError(null);
    setMessage('Local review discarded.');
  }
  function toggle(row: DuplicateRow) {
    try {
      setRows(setDuplicateKeep(rows, row.row, !row.keep));
      setError(null);
      setMessage('');
    } catch (failure) {
      setError(failure);
    }
  }
  function exportReport(format: 'csv' | 'json') {
    try {
      const content = exportDuplicateReview(rows, format);
      saveFile(
        new Blob([content], {
          type:
            format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json',
        }),
        `picfind-duplicate-review.${format}`,
      );
      setMessage(
        'Decision report downloaded. It contains metadata only and does not delete or upload originals.',
      );
      setError(null);
    } catch (failure) {
      setError(failure);
    }
  }
  return (
    <section className="glass-panel duplicate-review">
      <h1>Exact duplicate review</h1>
      <p>
        Compare local file bytes before importing. SHA-256 groups byte-identical
        copies, even when filenames differ. Visually similar or recompressed
        images may belong to different groups.
      </p>
      <p>
        Files stay on this device. Up to 100 JPEG, PNG or WebP entries, 8 MiB
        each and 256 MiB total. Files are hashed one at a time and are not
        decoded or uploaded.
      </p>
      <p className="duplicate-local-note">
        This review exists only in this tab. Leaving this page, reloading or
        switching accounts discards it. Export your decisions to retain them.
        Originals are never changed.
      </p>
      <label className="duplicate-file-input">
        Choose local photos
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          disabled={busy}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
            void scan(files);
          }}
        />
      </label>
      {busy && (
        <div className="duplicate-progress" role="status">
          <p>
            Hashed {progress.completed} of {progress.total} files.
          </p>
          <progress
            aria-label="Local hashing progress"
            max={progress.total}
            value={progress.completed}
          />
          <button
            type="button"
            className="button"
            disabled={pending.current?.signal.aborted}
            onClick={cancel}
          >
            Cancel scan
          </button>
          <p>
            Cancellation discards the result of any read already in progress.
          </p>
        </div>
      )}
      <ErrorNote error={error} />
      {message && <p role="status">{message}</p>}
      {!rows.length && !busy && (
        <p>
          No local review loaded. Select files to compare their exact bytes.
        </p>
      )}
      {!!rows.length && (
        <>
          <dl className="duplicate-totals" aria-label="Local review totals">
            <div>
              <dt>Files checked</dt>
              <dd>{rows.length}</dd>
            </div>
            <div>
              <dt>Duplicate groups</dt>
              <dd>{summary.groups}</dd>
            </div>
            <div>
              <dt>Extra copies found</dt>
              <dd>{summary.extraCopies}</dd>
            </div>
            <div>
              <dt>Kept in selection</dt>
              <dd>{summary.kept}</dd>
            </div>
            <div>
              <dt>Excluded from selection</dt>
              <dd>{summary.excluded}</dd>
            </div>
            <div>
              <dt>Bytes excluded from selection</dt>
              <dd>{summary.excludedBytes.toLocaleString('en-US')}</dd>
            </div>
          </dl>
          <p>
            Excluded bytes describe this proposed selection. No disk space has
            been freed.
          </p>
          <div className="duplicate-actions">
            <button
              type="button"
              className="button"
              disabled={!summary.extraCopies}
              onClick={() => {
                setRows(keepOneDuplicateCopy(rows));
                setError(null);
                setMessage(
                  'One currently kept copy per group is selected. You can restore any copy below.',
                );
              }}
            >
              Keep one copy per group
            </button>
            <button
              type="button"
              className="button"
              disabled={!summary.excluded}
              onClick={() => {
                setRows(rows.map((row) => ({ ...row, keep: true })));
                setError(null);
                setMessage('All copies restored to the selection.');
              }}
            >
              Restore all copies
            </button>
            <button
              type="button"
              className="button"
              onClick={() => exportReport('csv')}
            >
              Export decisions CSV
            </button>
            <button
              type="button"
              className="button"
              onClick={() => exportReport('json')}
            >
              Export decisions JSON
            </button>
            <button type="button" className="button danger" onClick={clear}>
              Discard local review
            </button>
          </div>
          <label className="duplicate-filter">
            <input
              type="checkbox"
              checked={duplicatesOnly}
              onChange={(event) => setDuplicatesOnly(event.target.checked)}
            />
            Show duplicate groups only
          </label>
          {!summary.groups && duplicatesOnly && (
            <p>
              No byte-identical duplicates found. Turn off the filter to inspect
              every file.
            </p>
          )}
          <div className="duplicate-groups">
            {groups
              .filter((group) => !duplicatesOnly || group.length > 1)
              .map((group) => {
                const retained = group.filter((row) => row.keep).length;
                return (
                  <section
                    className="duplicate-group"
                    key={group[0]!.row}
                    aria-label={`File group ${group[0]!.row}`}
                  >
                    <h2>
                      {group.length > 1
                        ? `${group.length} byte-identical copies`
                        : 'Unique file bytes'}
                    </h2>
                    <p>
                      {group[0]!.size.toLocaleString('en-US')} bytes per file.{' '}
                      {retained} kept.
                    </p>
                    <details>
                      <summary>SHA-256 digest</summary>
                      <code>{group[0]!.digest}</code>
                    </details>
                    <ul>
                      {group.map((row) => (
                        <li key={row.row}>
                          <label className="duplicate-choice">
                            <input
                              type="checkbox"
                              aria-label={`Keep input ${row.row}: ${row.name}`}
                              checked={row.keep}
                              disabled={row.keep && retained === 1}
                              onChange={() => toggle(row)}
                            />
                            <span>
                              <strong>{row.name}</strong>
                              <small>
                                Input {row.row}.{' '}
                                {row.keep ? 'Keep' : 'Exclude from selection'}.
                                Modified{' '}
                                {new Date(row.modifiedAt).toISOString()}.
                              </small>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                    <p>
                      At least one copy stays selected. To change the retained
                      copy, select another before excluding this one.
                    </p>
                  </section>
                );
              })}
          </div>
        </>
      )}
    </section>
  );
}
