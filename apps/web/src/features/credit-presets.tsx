import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, HttpError, session } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import {
  CREDIT_ACTOR_HEADER,
  CREDIT_BATCH_LIMIT,
  creditChange,
  creditPhotoPage,
  creditPresetDirectory,
  creditPresetWrite,
  creditPreview,
  creditPreviewWrite,
  photoCredit,
  savedCreditPreset,
  type CreditPresetDirectory,
  type CreditPresetFields,
  type CreditPreview,
  type SavedCreditPreset,
} from '../../../../packages/shared/src/credit-presets';
import './credit-presets.css';

const blank = (): CreditPresetFields => ({ label: '', name: '', website: '' });
const headers = (id: string) => ({ [CREDIT_ACTOR_HEADER]: id });
const denied = (error: unknown) =>
  error instanceof HttpError && [401, 403].includes(error.status);
async function readPresets(id: string, signal: AbortSignal) {
  const result = creditPresetDirectory.parse(
    await api('/studio/credit-presets', { signal, headers: headers(id) }),
  );
  if (result.accountId !== id)
    throw new HttpError(
      403,
      'Your signed-in account changed. Reload photographer credits.',
    );
  return result;
}
export function PhotographerCredits() {
  const query = useQuery({
    queryKey: ['session'],
    queryFn: session,
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  if (query.isPending) return <Loading />;
  if (query.error || !query.data)
    return (
      <ErrorNote
        error={
          query.error ?? new Error('Sign in to manage photographer credits.')
        }
      />
    );
  return <CreditDesk key={query.data.id} accountId={query.data.id} />;
}
function CreditDesk({ accountId }: { accountId: string }) {
  const cache = useQueryClient(),
    presetKey = ['credit-presets', accountId];
  const presets = useQuery({
    queryKey: presetKey,
    queryFn: ({ signal }) => readPresets(accountId, signal),
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  const [selectedPreset, setSelectedPreset] =
      useState<SavedCreditPreset | null>(null),
    [draft, setDraft] = useState(blank),
    [newId, setNewId] = useState(() => crypto.randomUUID()),
    [presetConflict, setPresetConflict] = useState(false),
    [filter, setFilter] = useState({ eventId: '', search: '', offset: 0 }),
    [selected, setSelected] = useState<Map<string, string>>(() => new Map()),
    [fields, setFields] = useState({ name: '', website: '', published: false }),
    [replace, setReplace] = useState(false),
    [preview, setPreview] = useState<CreditPreview | null>(null),
    [completed, setCompleted] = useState<Set<string>>(() => new Set()),
    [busy, setBusy] = useState(false),
    [applying, setApplying] = useState(false),
    [error, setError] = useState<unknown>(null),
    [message, setMessage] = useState(''),
    [locked, setLocked] = useState(false);
  const pending = useRef<AbortController | null>(null),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.abort();
    };
  }, []);
  const photos = useQuery({
    queryKey: ['credit-photos', accountId, filter],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({
        search: filter.search,
        offset: String(filter.offset),
      });
      if (filter.eventId) params.set('eventId', filter.eventId);
      const result = creditPhotoPage.parse(
        await api(`/studio/credit-photos?${params}`, {
          signal,
          headers: headers(accountId),
        }),
      );
      if (result.accountId !== accountId)
        throw new HttpError(
          403,
          'Your signed-in account changed. Reload photographer credits.',
        );
      return result;
    },
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  const presetFields = selectedPreset
    ? {
        label: selectedPreset.label,
        name: selectedPreset.name,
        website: selectedPreset.website,
      }
    : blank();
  const dirty = JSON.stringify(draft) !== JSON.stringify(presetFields);
  const stalePreset =
    !!selectedPreset &&
    !!presets.data &&
    presets.data.presets.find((row) => row.id === selectedPreset.id)
      ?.version !== selectedPreset.version;
  async function run(
    operation: (signal: AbortSignal) => Promise<void>,
    batch = false,
  ) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setApplying(batch);
    setError(null);
    setMessage('');
    try {
      await operation(controller.signal);
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted) return;
      setError(failure);
      if (batch)
        setMessage(
          'Batch paused. Confirmed changes remain. Retry the remaining requests or prepare a fresh preview after resolving the error.',
        );
      if (denied(failure)) setLocked(true);
      if (
        failure instanceof HttpError &&
        failure.code === 'CREDIT_PRESET_CHANGED'
      )
        setPresetConflict(true);
    } finally {
      pending.current = null;
      if (mounted.current) {
        setBusy(false);
        setApplying(false);
      }
    }
  }
  function choose(preset: SavedCreditPreset | null) {
    setSelectedPreset(preset);
    setDraft(
      preset
        ? { label: preset.label, name: preset.name, website: preset.website }
        : blank(),
    );
    setNewId(crypto.randomUUID());
    setPresetConflict(false);
    setError(null);
  }
  function resetPreview() {
    setPreview(null);
    setCompleted(new Set());
    setMessage('');
  }
  function updateFields(value: typeof fields) {
    setFields(value);
    resetPreview();
  }
  async function savePreset(event: FormEvent) {
    event.preventDefault();
    await run(async (signal) => {
      const input = creditPresetWrite.safeParse({
        ...draft,
        version: selectedPreset?.version ?? 0,
      });
      if (!input.success)
        throw new Error(
          'Enter a label, credit name and an optional HTTPS website without credentials.',
        );
      const id = selectedPreset?.id ?? newId;
      const result = await api<{ accountId: string; preset: unknown }>(
        `/studio/credit-presets/${id}`,
        {
          method: 'PUT',
          signal,
          headers: headers(accountId),
          body: JSON.stringify(input.data),
        },
      );
      signal.throwIfAborted();
      const preset = savedCreditPreset.parse(result.preset);
      if (result.accountId !== accountId || preset.id !== id)
        throw new HttpError(
          403,
          'The saved preset does not belong to this account and request.',
        );
      cache.setQueryData<CreditPresetDirectory>(presetKey, (current) =>
        current
          ? {
              ...current,
              presets: [
                ...current.presets.filter((row) => row.id !== id),
                preset,
              ],
            }
          : current,
      );
      choose(preset);
      setMessage(
        'Private preset saved. Existing photo credits were not changed.',
      );
    });
  }
  async function reloadPresets() {
    if (
      dirty &&
      !window.confirm(
        'Discard unsaved preset changes and reload saved presets?',
      )
    )
      return;
    await run(async (signal) => {
      const current = await readPresets(accountId, signal);
      signal.throwIfAborted();
      cache.setQueryData(presetKey, current);
      choose(
        current.presets.find((row) => row.id === selectedPreset?.id) ?? null,
      );
      setMessage('Saved presets reloaded.');
    });
  }
  async function removePreset() {
    if (
      !selectedPreset ||
      !window.confirm(
        'Remove this preset? Credits already saved on photos will remain unchanged.',
      )
    )
      return;
    await run(async (signal) => {
      await api(`/studio/credit-presets/${selectedPreset.id}`, {
        method: 'DELETE',
        signal,
        headers: headers(accountId),
        body: JSON.stringify({ version: selectedPreset.version }),
      });
      signal.throwIfAborted();
      cache.setQueryData<CreditPresetDirectory>(presetKey, (current) =>
        current
          ? {
              ...current,
              presets: current.presets.filter(
                (row) => row.id !== selectedPreset.id,
              ),
            }
          : current,
      );
      choose(null);
      setMessage('Preset removed. Existing photo credits remain.');
    });
  }
  function toggle(id: string, filename: string) {
    const next = new Map(selected);
    if (next.has(id)) next.delete(id);
    else if (next.size < CREDIT_BATCH_LIMIT) next.set(id, filename);
    setSelected(next);
    resetPreview();
  }
  async function prepare() {
    await run(async (signal) => {
      const input = creditPreviewWrite.safeParse({
        photoIds: [...selected.keys()],
        fields,
      });
      if (!input.success)
        throw new Error(
          'Choose up to 100 photos and valid credit fields. Publishing requires a name.',
        );
      const result = creditPreview.parse(
        await api('/photos/attribution-preview', {
          method: 'POST',
          signal,
          headers: headers(accountId),
          body: JSON.stringify(input.data),
        }),
      );
      signal.throwIfAborted();
      if (
        result.accountId !== accountId ||
        JSON.stringify(result.photos.map((row) => row.id)) !==
          JSON.stringify(input.data.photoIds) ||
        JSON.stringify(result.fields) !== JSON.stringify(input.data.fields)
      )
        throw new HttpError(
          403,
          'This preview does not match the current account and selection.',
        );
      setFields(result.fields);
      setPreview(result);
      setCompleted(new Set());
      setMessage('Preview ready. Review the exact changes before applying.');
    });
  }
  async function apply() {
    if (!preview) return;
    const updates = preview.photos.filter(
      (row) => creditChange(row.current, preview.fields, replace) === 'update',
    );
    if (
      !window.confirm(
        `Apply ${updates.filter((row) => !completed.has(row.id)).length} remaining photo credit updates? Completed changes remain if the batch stops.`,
      )
    )
      return;
    await run(async (signal) => {
      const done = new Set(completed);
      for (const row of updates) {
        if (done.has(row.id)) continue;
        signal.throwIfAborted();
        setMessage(
          `Updating ${row.filename}. ${done.size} of ${updates.length} confirmed.`,
        );
        const result = await api<{ attribution: unknown }>(
          `/photos/${row.id}/attribution`,
          {
            method: 'PATCH',
            signal,
            headers: headers(accountId),
            body: JSON.stringify({
              ...preview.fields,
              version: row.current.version,
            }),
          },
        );
        signal.throwIfAborted();
        const credit = photoCredit.parse(result.attribution);
        if (
          credit.name !== preview.fields.name ||
          credit.website !== preview.fields.website ||
          credit.published !== preview.fields.published ||
          credit.version < row.current.version ||
          credit.version > row.current.version + 1
        )
          throw new Error(
            'The saved photo credit did not match this preview. Reload before preparing another batch.',
          );
        done.add(row.id);
        setCompleted(new Set(done));
      }
      setMessage(
        `${done.size} photo credit updates confirmed. Preserved and unchanged credits were not rewritten.`,
      );
      void cache.invalidateQueries({ queryKey: ['library'] });
      void cache.invalidateQueries({ queryKey: ['event-gallery'] });
    }, true);
  }
  if (locked || denied(presets.error) || denied(photos.error))
    return <ErrorNote error={error ?? presets.error ?? photos.error} />;
  const updates =
    preview?.photos.filter(
      (row) => creditChange(row.current, preview.fields, replace) === 'update',
    ) ?? [];
  return (
    <section className="glass-panel credit-desk">
      <p className="eyebrow">Photographer identity</p>
      <h1>Photo credits</h1>
      <p>
        Reuse a photographer credit across selected photos. Preview first.
        Existing credits are preserved unless you explicitly choose replacement.
      </p>
      <ErrorNote error={error} />
      <p role="status">{message}</p>
      <section className="credit-card" aria-label="Private credit presets">
        <h2>Private presets</h2>
        <ErrorNote error={presets.error} />
        <p>Presets do not publish anything or update photos automatically.</p>
        <fieldset disabled={busy || presets.isFetching}>
          <label>
            Saved preset
            <select
              value={selectedPreset?.id ?? ''}
              onChange={(e) => {
                if (dirty && !window.confirm('Discard unsaved preset changes?'))
                  return;
                choose(
                  presets.data?.presets.find(
                    (row) => row.id === e.target.value,
                  ) ?? null,
                );
              }}
            >
              <option value="">New preset</option>
              {presets.data?.presets.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.label}
                </option>
              ))}
            </select>
          </label>
          <form onSubmit={savePreset}>
            <label>
              Preset label
              <input
                required
                maxLength={80}
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              />
            </label>
            <label>
              Preset credit name
              <input
                required
                maxLength={100}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label>
              Preset website
              <input
                type="url"
                maxLength={512}
                value={draft.website}
                onChange={(e) =>
                  setDraft({ ...draft, website: e.target.value })
                }
                placeholder="https://example.com"
              />
            </label>
            <div className="credit-actions">
              <button
                className="button"
                disabled={
                  !!presets.error ||
                  presetConflict ||
                  stalePreset ||
                  (!selectedPreset &&
                    (!presets.data ||
                      presets.data.presets.length >= presets.data.limit))
                }
              >
                Save preset
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={() => void reloadPresets()}
              >
                Reload presets
              </button>
              {selectedPreset && (
                <button
                  className="button secondary"
                  type="button"
                  disabled={presetConflict || stalePreset}
                  onClick={() => void removePreset()}
                >
                  Remove preset
                </button>
              )}
            </div>
          </form>
          {(presetConflict || stalePreset) && (
            <p role="alert">
              This preset changed. Your draft is preserved. Reload the saved
              preset before continuing.
            </p>
          )}
          <p>
            {presets.data
              ? `${presets.data.presets.length} / 20 retained presets.`
              : presets.error
                ? 'Saved presets are unavailable.'
                : 'Loading saved presets.'}
          </p>
          {selectedPreset && (
            <button
              className="button secondary"
              disabled={stalePreset || presetConflict}
              onClick={() =>
                updateFields({
                  ...fields,
                  name: selectedPreset.name,
                  website: selectedPreset.website,
                })
              }
            >
              Use saved preset in batch
            </button>
          )}
        </fieldset>
      </section>
      <section className="credit-card" aria-label="Photo credit batch">
        <h2>Prepare a photo batch</h2>
        <fieldset disabled={busy}>
          <div className="credit-grid">
            <label>
              Batch credit name
              <input
                maxLength={100}
                value={fields.name}
                onChange={(e) =>
                  updateFields({ ...fields, name: e.target.value })
                }
              />
            </label>
            <label>
              Batch website
              <input
                type="url"
                maxLength={512}
                value={fields.website}
                onChange={(e) =>
                  updateFields({ ...fields, website: e.target.value })
                }
                placeholder="https://example.com"
              />
            </label>
          </div>
          <label className="credit-check">
            <input
              type="checkbox"
              checked={fields.published}
              onChange={(e) =>
                updateFields({ ...fields, published: e.target.checked })
              }
            />
            Publish this credit with authorized photo delivery.
          </label>
          <label className="credit-check">
            <input
              type="checkbox"
              checked={replace}
              onChange={(e) => {
                setReplace(e.target.checked);
                resetPreview();
              }}
            />
            Replace existing nonempty credits in this selection.
          </label>
          <p>
            Private credits are excluded from new gallery and download
            projections. Changing credits cannot recall earlier downloads.
          </p>
          <div className="credit-grid">
            <label>
              Photo event
              <select
                value={filter.eventId}
                onChange={(e) =>
                  setFilter({ ...filter, eventId: e.target.value, offset: 0 })
                }
              >
                <option value="">All owned photos</option>
                <option value="library">Photos without an event</option>
                {photos.data?.events.map((event) => (
                  <option key={event.id} value={event.id}>
                    {event.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Find photo filenames
              <input
                maxLength={200}
                value={filter.search}
                onChange={(e) =>
                  setFilter({ ...filter, search: e.target.value, offset: 0 })
                }
              />
            </label>
          </div>
          <ErrorNote error={photos.error} />
          {photos.isPending ? (
            <Loading />
          ) : (
            photos.data &&
            !photos.error && (
              <div className="credit-photo-list">
                {photos.data.photos.map((photo) => (
                  <label className="credit-check" key={photo.id}>
                    <input
                      type="checkbox"
                      checked={selected.has(photo.id)}
                      disabled={
                        !selected.has(photo.id) &&
                        selected.size >= CREDIT_BATCH_LIMIT
                      }
                      onChange={() => toggle(photo.id, photo.filename)}
                    />
                    {photo.filename}
                  </label>
                ))}
                {!photos.data.photos.length && (
                  <p>No available owned photos match these filters.</p>
                )}
                <p>
                  {photos.data.totalCount} matching photos. Showing{' '}
                  {photos.data.photos.length} from position{' '}
                  {photos.data.offset + 1}.
                </p>
              </div>
            )
          )}
          <div className="credit-actions">
            <button
              className="button secondary"
              disabled={
                photos.isFetching ||
                !!photos.error ||
                !photos.data?.photos.length ||
                selected.size >= CREDIT_BATCH_LIMIT
              }
              onClick={() => {
                const next = new Map(selected);
                for (const photo of photos.data?.photos ?? []) {
                  if (next.size >= CREDIT_BATCH_LIMIT) break;
                  next.set(photo.id, photo.filename);
                }
                setSelected(next);
                resetPreview();
              }}
            >
              Select this page
            </button>
            <button
              className="button secondary"
              disabled={filter.offset === 0 || photos.isFetching}
              onClick={() =>
                setFilter({
                  ...filter,
                  offset: Math.max(0, filter.offset - 100),
                })
              }
            >
              Previous photos
            </button>
            <button
              className="button secondary"
              disabled={
                !photos.data ||
                filter.offset + 100 >= photos.data.totalCount ||
                photos.isFetching
              }
              onClick={() =>
                setFilter({ ...filter, offset: filter.offset + 100 })
              }
            >
              Next photos
            </button>
            <button
              className="button secondary"
              onClick={() => void photos.refetch()}
            >
              Reload photos
            </button>
            <button
              className="button secondary"
              onClick={() => {
                setSelected(new Map());
                resetPreview();
              }}
            >
              Clear selection
            </button>
          </div>
          <p>
            {selected.size} / {CREDIT_BATCH_LIMIT} photos selected across
            filters and pages.
          </p>
          <button
            className="button"
            disabled={!selected.size || photos.isFetching || !!photos.error}
            onClick={() => void prepare()}
          >
            Preview credit changes
          </button>
        </fieldset>
        {preview && (
          <section aria-label="Credit change preview">
            <h3>Review photo credit changes</h3>
            <p>
              Proposed: {preview.fields.name || 'No name'} ·{' '}
              {preview.fields.website || 'No website'} ·{' '}
              {preview.fields.published ? 'Published' : 'Private'}
            </p>
            <p>
              {updates.length} updates; {preview.photos.length - updates.length}{' '}
              preserved or unchanged. {completed.size} updates confirmed.
            </p>
            <ul className="credit-preview-list">
              {preview.photos.map((row) => (
                <li key={row.id}>
                  <strong>{row.filename}</strong>
                  <span>
                    {completed.has(row.id)
                      ? 'Confirmed'
                      : creditChange(row.current, preview.fields, replace)}
                  </span>
                  <p>
                    Current: {row.current.name || 'No name'} ·{' '}
                    {row.current.website || 'No website'} ·{' '}
                    {row.current.published ? 'Published' : 'Private'}
                  </p>
                </li>
              ))}
            </ul>
            <div className="credit-actions">
              <button
                className="button"
                disabled={busy || completed.size === updates.length}
                onClick={() => void apply()}
              >
                {completed.size
                  ? 'Apply remaining credit changes'
                  : 'Apply credit changes'}
              </button>
              {applying && (
                <button
                  className="button secondary"
                  onClick={() => {
                    pending.current?.abort();
                    setMessage(
                      'Batch stopped. Confirmed changes remain. An in-flight save may have completed; retry this preview to reconcile it.',
                    );
                  }}
                >
                  Stop credit batch
                </button>
              )}
            </div>
          </section>
        )}
      </section>
    </section>
  );
}
