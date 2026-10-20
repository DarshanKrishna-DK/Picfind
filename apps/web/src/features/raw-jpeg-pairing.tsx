import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, saveFile, session } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import {
  RAW_MANIFEST_LIMIT,
  applyRawSuggestions,
  decodeRawMapping,
  encodeRawMapping,
  eventJpegs,
  exportRawPairs,
  prepareRawPairs,
  rawBasename,
  resolveRawPairs,
  type PairPhoto,
  type PairResolution,
  type RawPair,
} from '../../../../packages/shared/src/raw-jpeg';

export function RawJpegPairing({ eventId }: { eventId: string }) {
  const account = useQuery({
    queryKey: ['session'],
    queryFn: session,
    retry: false,
  });
  if (account.isPending) return <Loading />;
  if (!account.data || account.error)
    return (
      <ErrorNote
        error={account.error ?? new Error('Sign in to pair your originals.')}
      />
    );
  return (
    <PairingWorkspace
      key={`${account.data.id}:${eventId}`}
      accountId={account.data.id}
      eventId={eventId}
    />
  );
}

function PairingWorkspace({
  accountId,
  eventId,
}: {
  accountId: string;
  eventId: string;
}) {
  const [entries, setEntries] = useState<RawPair[]>([]);
  const [skipped, setSkipped] = useState<{ path: string; reason: string }[]>(
    [],
  );
  const [photos, setPhotos] = useState<PairPhoto[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const mapping = useRef<HTMLInputElement>(null);
  const pending = useRef<AbortController | null>(null);
  const mounted = useRef(false);

  async function currentPhotos(signal: AbortSignal) {
    const result = await api<{
      event: { id: string; ownerId: string; accessRole: string };
      photos: PairPhoto[];
    }>(`/events/${encodeURIComponent(eventId)}/gallery`, { signal });
    signal.throwIfAborted();
    if (
      result.event?.id !== eventId ||
      result.event.ownerId !== accountId ||
      result.event.accessRole !== 'owner'
    )
      throw new Error(
        'This editing workspace is unavailable for the current account.',
      );
    return eventJpegs(result.photos);
  }
  async function refresh(exportCsv = false) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    setMessage('');
    setPhotos(null);
    try {
      const current = await currentPhotos(controller.signal);
      setPhotos(current);
      if (exportCsv) {
        const output = exportRawPairs(entries, current);
        controller.signal.throwIfAborted();
        saveFile(
          new Blob([output.content], { type: 'text/csv;charset=utf-8' }),
          `picfind-raw-pairs-${eventId}.csv`,
        );
        setMessage(
          `${output.count} mappings exported. ${output.skipped} explicitly skipped.`,
        );
      } else setMessage('Current event JPEGs loaded.');
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure);
    } finally {
      if (pending.current === controller) pending.current = null;
      if (mounted.current && !controller.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      pending.current?.abort();
      pending.current = null;
    };
    // The workspace key fixes the account and event for this mount.
  }, []);
  function replaceAllowed() {
    return (
      !busy &&
      (!entries.length ||
        window.confirm(
          'Replace this local mapping? Download its JSON first if you want to keep it.',
        ))
    );
  }
  function prepare(selected: File[]) {
    if (!replaceAllowed()) return;
    setError(null);
    try {
      const result = prepareRawPairs(selected);
      setEntries(result.entries);
      setSkipped(result.skipped);
      setDirty(true);
      setMessage(
        `${result.entries.length} RAW filenames prepared. ${result.skipped.length} files skipped. Review suggestions before applying them.`,
      );
    } catch (failure) {
      setError(failure);
    } finally {
      if (files.current) files.current.value = '';
      if (folder.current) folder.current.value = '';
    }
  }
  async function restore(file: File | undefined) {
    if (!file || !replaceAllowed()) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    try {
      if (file.size > RAW_MANIFEST_LIMIT)
        throw new Error('This RAW mapping is too large.');
      const text = await file.text();
      controller.signal.throwIfAborted();
      const restored = decodeRawMapping(text, accountId, eventId);
      setEntries(restored);
      setSkipped([]);
      setDirty(false);
      setMessage(
        'Mapping restored. Refresh JPEGs or export to check current availability.',
      );
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure);
    } finally {
      if (mapping.current) mapping.current.value = '';
      if (pending.current === controller) pending.current = null;
      if (mounted.current && !controller.signal.aborted) setBusy(false);
    }
  }
  function downloadMapping() {
    if (busy) return;
    setError(null);
    try {
      const text = encodeRawMapping(accountId, eventId, entries);
      saveFile(
        new Blob([text], { type: 'application/json' }),
        `picfind-raw-mapping-${eventId}.json`,
      );
      setDirty(false);
      setMessage(
        'Mapping JSON downloaded. Keep it to restore this workspace later.',
      );
    } catch (failure) {
      setError(failure);
    }
  }
  const resolved = photos ? resolveRawPairs(entries, photos) : [];
  return (
    <section className="source-panel stack" aria-label="RAW to JPEG pairing">
      <h2>Match local originals to event JPEGs</h2>
      <p>
        Choose RAW files or their parent folder. Only filenames, relative paths,
        sizes and modification times are read. RAW image bytes are never
        uploaded or decoded by this tool.
      </p>
      <p>
        This workspace stays in memory. Download mapping JSON before leaving or
        reloading, then restore it here. JSON includes local paths and decisions
        for this account and event. It contains no image bytes.
      </p>
      <p>
        Up to 100 supported RAW entries from a selection of 500 files. Filename
        suggestions are not content verification. Repeated names need a manual
        choice, and each event JPEG can be assigned once.
      </p>
      <div className="toolbar">
        <button
          type="button"
          className="button secondary"
          disabled={busy || !photos}
          onClick={() => files.current?.click()}
        >
          Choose RAW files
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy || !photos}
          onClick={() => {
            folder.current?.setAttribute('webkitdirectory', '');
            folder.current?.click();
          }}
        >
          Choose RAW folder
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => mapping.current?.click()}
        >
          Restore mapping JSON
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh event JPEGs
        </button>
      </div>
      <input
        ref={files}
        className="visually-hidden"
        type="file"
        multiple
        aria-label="Local RAW files"
        disabled={busy}
        onChange={(event) => {
          const selected = Array.from(event.target.files ?? []);
          event.target.value = '';
          prepare(selected);
        }}
      />
      <input
        ref={folder}
        className="visually-hidden"
        type="file"
        multiple
        aria-label="Local RAW folder"
        disabled={busy}
        onChange={(event) => {
          const selected = Array.from(event.target.files ?? []);
          event.target.value = '';
          prepare(selected);
        }}
      />
      <input
        ref={mapping}
        className="visually-hidden"
        type="file"
        accept=".json,application/json"
        aria-label="Restore RAW mapping file"
        disabled={busy}
        onChange={(event) => {
          const selected = event.target.files?.[0];
          event.target.value = '';
          void restore(selected);
        }}
      />
      <ErrorNote error={error} />
      <p role="status">
        {busy ? 'Checking mapping and current access...' : message}
      </p>
      {photos && <p>{photos.length} currently available event JPEGs.</p>}
      {entries.length > 0 && (
        <>
          <p>
            {entries.length} RAW entries.{' '}
            {dirty
              ? 'Download JSON to preserve these changes.'
              : 'A mapping file has been downloaded or restored.'}
          </p>
          <div className="toolbar">
            <button
              type="button"
              className="button secondary"
              disabled={busy || !photos}
              onClick={() => {
                if (photos) {
                  setEntries(applyRawSuggestions(entries, photos));
                  setDirty(true);
                  setMessage(
                    'Unambiguous filename suggestions applied. Review all mappings before exporting.',
                  );
                }
              }}
            >
              Apply unambiguous suggestions
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={downloadMapping}
            >
              Download mapping JSON
            </button>
            <button
              type="button"
              className="button"
              disabled={busy || !photos}
              onClick={() => void refresh(true)}
            >
              Export RAW to JPEG CSV
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => {
                if (replaceAllowed()) {
                  setEntries([]);
                  setSkipped([]);
                  setDirty(false);
                  setMessage('Local mapping cleared. Event photos were kept.');
                }
              }}
            >
              Clear local mapping
            </button>
          </div>
          {!photos && (
            <p>
              Refresh current event access before reviewing or exporting JPEG
              mappings.
            </p>
          )}
          {photos &&
            resolved.map((row) => (
              <PairRow
                key={row.entry.path}
                row={row}
                photos={photos}
                disabled={busy}
                onChange={(choice) => {
                  setEntries((previous) =>
                    previous.map((entry) =>
                      entry.path === row.entry.path
                        ? { ...entry, choice }
                        : entry,
                    ),
                  );
                  setDirty(true);
                  setMessage('');
                  setError(null);
                }}
              />
            ))}
        </>
      )}
      {skipped.length > 0 && (
        <details>
          <summary>Skipped file report ({skipped.length})</summary>
          <ul>
            {skipped.map((item, index) => (
              <li key={index}>
                {item.path}: {item.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function PairRow({
  row,
  photos,
  disabled,
  onChange,
}: {
  row: PairResolution;
  photos: PairPhoto[];
  disabled: boolean;
  onChange: (choice: RawPair['choice']) => void;
}) {
  const [search, setSearch] = useState(rawBasename(row.entry.path));
  const query = search.normalize('NFC').toLocaleLowerCase('en-US');
  const matches = photos.filter((photo) =>
    photo.filename.normalize('NFC').toLocaleLowerCase('en-US').includes(query),
  );
  const candidates = matches.slice(0, 50);
  if (row.photo && !candidates.some((photo) => photo.id === row.photo!.id))
    candidates.unshift(row.photo);
  const value =
    row.entry.choice === 'skip' ? 'skip' : (row.entry.choice?.photoId ?? '');
  return (
    <fieldset className="stack" disabled={disabled}>
      <legend>{row.entry.path}</legend>
      <p>
        Status: {row.status}.{' '}
        {row.suggestion
          ? `Suggestion: ${row.suggestion.filename}.`
          : 'No unambiguous filename suggestion.'}
      </p>
      {row.status === 'conflict' && (
        <p role="alert">
          This JPEG is assigned to more than one RAW entry. Choose a different
          JPEG or skip an entry.
        </p>
      )}
      {row.status === 'renamed' && (
        <p role="alert">
          The JPEG filename changed. Choose it again to confirm the current
          filename.
        </p>
      )}
      {row.status === 'unavailable' && (
        <p role="alert">
          The chosen JPEG is no longer available. Choose another JPEG or skip
          this entry.
        </p>
      )}
      <label>
        Search JPEG for {row.entry.path}
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      {matches.length > 50 && (
        <p>
          Showing 50 of {matches.length} matches. Refine the search to find
          another JPEG.
        </p>
      )}
      <label>
        JPEG for {row.entry.path}
        <select
          value={value}
          onChange={(event) => {
            if (!event.target.value) onChange(null);
            else if (event.target.value === 'skip') onChange('skip');
            else {
              const photo = photos.find(
                (item) => item.id === event.target.value,
              );
              if (photo)
                onChange({ photoId: photo.id, filename: photo.filename });
            }
          }}
        >
          <option value="">Choose a JPEG</option>
          <option value="skip">Skip this RAW entry</option>
          {value && value !== 'skip' && !row.photo && (
            <option value={value}>
              Previously selected JPEG is unavailable
            </option>
          )}
          {candidates.map((photo) => (
            <option key={photo.id} value={photo.id}>
              {photo.filename} ({photo.id})
            </option>
          ))}
        </select>
      </label>
      {row.status === 'renamed' && row.photo && (
        <button
          type="button"
          className="button secondary"
          onClick={() =>
            onChange({ photoId: row.photo!.id, filename: row.photo!.filename })
          }
        >
          Confirm renamed JPEG for {row.entry.path}
        </button>
      )}
    </fieldset>
  );
}
