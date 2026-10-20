import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, HttpError, session, type Photo } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import {
  coverageItems,
  coveragePhotoIds,
  coverageSnapshot,
  coverageStatus,
  type CoverageCategory,
  type CoverageSnapshot,
} from '../../../../packages/shared/src/event-coverage';
import './event-coverage.css';

const headers = (accountId: string) => ({
  'X-PicFind-Coverage-Actor': accountId,
});
async function readCoverage(
  eventId: string,
  accountId: string,
  signal: AbortSignal,
) {
  const parsed = coverageSnapshot.parse(
    await api(`/events/${eventId}/coverage`, {
      headers: headers(accountId),
      signal,
    }),
  );
  if (parsed.accountId !== accountId || parsed.eventId !== eventId)
    throw new HttpError(
      403,
      'This coverage response belongs to another account or event.',
    );
  return parsed;
}
export function EventCoverage({
  eventId,
  photos,
}: {
  eventId: string;
  photos: Photo[];
}) {
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
        error={account.error ?? new Error('Sign in to view private coverage.')}
      />
    );
  return (
    <CoverageLoader
      key={`${account.data.id}:${eventId}`}
      eventId={eventId}
      accountId={account.data.id}
      photos={photos}
    />
  );
}
function CoverageLoader({
  eventId,
  accountId,
  photos,
}: {
  eventId: string;
  accountId: string;
  photos: Photo[];
}) {
  const query = useQuery({
    queryKey: ['event-coverage', accountId, eventId],
    queryFn: ({ signal }) => readCoverage(eventId, accountId, signal),
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  if (query.isPending) return <Loading />;
  if (query.error)
    return (
      <section className="settings-panel">
        <h2>Event coverage</h2>
        <ErrorNote error={query.error} />
        <button
          className="button"
          type="button"
          onClick={() => void query.refetch()}
        >
          Retry coverage
        </button>
      </section>
    );
  return <CoverageEditor initial={query.data} photos={photos} />;
}
function CoverageEditor({
  initial,
  photos,
}: {
  initial: CoverageSnapshot;
  photos: Photo[];
}) {
  const [saved, setSaved] = useState(initial);
  const [items, setItems] = useState(initial.plan.items);
  const [selected, setSelected] = useState('');
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(50);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    [],
  );
  const dirty = JSON.stringify(items) !== JSON.stringify(saved.plan.items);
  const chosen = items.find((item) => item.id === selected);
  const available = useMemo(
    () => new Set(saved.availableIds),
    [saved.availableIds],
  );
  const assigned = useMemo(
    () => new Set(coveragePhotoIds(saved.plan.items)),
    [saved.plan.items],
  );
  const byId = useMemo(
    () =>
      new Map(
        photos
          .filter((photo) => photo.eventId === initial.eventId)
          .map((photo) => [photo.id, photo]),
      ),
    [photos, initial.eventId],
  );
  const statuses = saved.plan.items.map((item) =>
    coverageStatus(item, available),
  );
  const references = items.reduce(
    (total, item) => total + item.photoIds.length,
    0,
  );
  const valid = coverageItems.safeParse(items).success;
  const candidates = [...byId.values()].filter(
    (photo) =>
      !chosen?.photoIds.includes(photo.id) &&
      (!assigned.has(photo.id) || available.has(photo.id)) &&
      photo.filename.toLowerCase().includes(search.trim().toLowerCase()),
  );
  function edit(changes: Partial<CoverageCategory>) {
    setItems(
      items.map((item) =>
        item.id === selected ? { ...item, ...changes } : item,
      ),
    );
    setMessage('');
  }
  function add() {
    const id = crypto.randomUUID();
    setItems([...items, { id, label: '', target: 1, note: '', photoIds: [] }]);
    setSelected(id);
    setSearch('');
    setShown(50);
    setMessage('');
  }
  async function run(save: boolean) {
    if (
      pending.current ||
      (save && (locked || denied || !saved.editable || !valid))
    )
      return;
    if (
      !save &&
      dirty &&
      !window.confirm(
        'Reload the saved coverage plan and discard unsaved changes?',
      )
    )
      return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      const raw = save
        ? await api(`/events/${initial.eventId}/coverage`, {
            method: 'PUT',
            headers: headers(initial.accountId),
            signal: controller.signal,
            body: JSON.stringify({ version: saved.plan.version, items }),
          })
        : await readCoverage(
            initial.eventId,
            initial.accountId,
            controller.signal,
          );
      controller.signal.throwIfAborted();
      const next = coverageSnapshot.parse(raw);
      if (
        next.accountId !== initial.accountId ||
        next.eventId !== initial.eventId
      )
        throw new HttpError(
          403,
          'Your signed-in account changed. Reload the event.',
        );
      setSaved(next);
      setItems(next.plan.items);
      setSelected(
        next.plan.items.some((item) => item.id === selected) ? selected : '',
      );
      setLocked(false);
      setDenied(false);
      setMessage(
        save
          ? 'Private coverage plan saved. Counts use currently available assigned photos.'
          : 'Saved coverage and photo availability refreshed.',
      );
    } catch (failure) {
      if (controller.signal.aborted) return;
      setError(failure);
      if (failure instanceof HttpError && failure.status === 409)
        setLocked(true);
      if (
        failure instanceof HttpError &&
        [401, 403, 404].includes(failure.status)
      ) {
        setDenied(true);
        setItems([]);
        setSelected('');
        setSaved({
          ...initial,
          plan: { version: 0, updatedAt: null, items: [] },
          availableIds: [],
        });
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <section
      className="settings-panel event-coverage"
      aria-label="Private event coverage"
    >
      <h2>Event coverage</h2>
      <p>
        Define the shots you need and assign photos yourself. Counts reflect
        available manual assignments, not detected attendance or image quality.
        This checklist is private.
      </p>
      <ErrorNote error={error} />
      {message && <p role="status">{message}</p>}
      {denied ? (
        <p>
          Private coverage is hidden until your account and event access are
          checked again.
        </p>
      ) : (
        <>
          <div
            className="coverage-saved-summary"
            aria-label="Saved coverage status"
          >
            <strong>Saved coverage</strong>
            <span>
              {statuses.filter((item) => item.status === 'missing').length}{' '}
              missing
            </span>
            <span>
              {statuses.filter((item) => item.status === 'partial').length}{' '}
              partial
            </span>
            <span>
              {statuses.filter((item) => item.status === 'target-met').length}{' '}
              target met
            </span>
          </div>
          <p>
            {saved.plan.updatedAt
              ? `Saved ${saved.plan.updatedAt}.`
              : 'No coverage plan saved yet.'}{' '}
            Refresh to check current photo availability.
          </p>
          {!!saved.plan.items.length && (
            <ul
              className="coverage-status-list"
              aria-label="Saved shot categories"
            >
              {saved.plan.items.map((item) => {
                const state = coverageStatus(item, available);
                return (
                  <li key={item.id}>
                    <strong>{item.label}</strong>
                    <span>
                      {state.count} of {item.target} available assignments.{' '}
                      {state.remaining
                        ? `${state.remaining} still needed.`
                        : 'Target met.'}
                      {state.unavailable
                        ? ` ${state.unavailable} unavailable assignments.`
                        : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {dirty && (
            <p role="status">
              Unsaved coverage changes. Saved counts above do not include this
              draft.
            </p>
          )}
          {!saved.editable && (
            <p>
              Archived or expired event. Restore an active event before editing
              this plan.
            </p>
          )}
          {locked && (
            <p>
              Your draft is preserved for inspection. Reload the saved plan
              before editing or saving again.
            </p>
          )}
          <fieldset
            disabled={busy || locked || !saved.editable}
            className="coverage-editor"
          >
            <legend>Coverage draft</legend>
            <p>
              {items.length} of 20 categories. {references} of 100 photo
              references.
            </p>
            <button
              className="button"
              type="button"
              disabled={items.length >= 20}
              onClick={add}
            >
              Add shot category
            </button>
            <div className="coverage-columns">
              <ul className="coverage-categories" aria-label="Draft categories">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      className="button secondary"
                      type="button"
                      aria-pressed={item.id === selected}
                      onClick={() => {
                        setSelected(item.id);
                        setSearch('');
                        setShown(50);
                      }}
                    >
                      {item.label || 'Untitled category'}
                    </button>
                  </li>
                ))}
              </ul>
              {chosen && (
                <div className="coverage-fields">
                  <label>
                    Shot category name
                    <input
                      maxLength={80}
                      value={chosen.label}
                      onChange={(event) => edit({ label: event.target.value })}
                    />
                  </label>
                  <label>
                    Target photo count
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={chosen.target}
                      onChange={(event) =>
                        edit({ target: Number(event.target.value) })
                      }
                    />
                  </label>
                  <label>
                    Private coverage note
                    <textarea
                      maxLength={200}
                      value={chosen.note}
                      onChange={(event) => edit({ note: event.target.value })}
                    />
                  </label>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => {
                      if (
                        window.confirm(
                          'Remove this category from the draft? Save the plan to persist the removal. Photos remain unchanged.',
                        )
                      ) {
                        setItems(items.filter((item) => item.id !== chosen.id));
                        setSelected('');
                        setMessage('');
                      }
                    }}
                  >
                    Remove category from draft
                  </button>
                  <h3>Assigned photos</h3>
                  {!chosen.photoIds.length && (
                    <p>No photos assigned to this category.</p>
                  )}
                  <ul
                    className="coverage-assignments"
                    aria-label="Assigned coverage photos"
                  >
                    {chosen.photoIds.map((id) => (
                      <li key={id}>
                        <span>
                          {assigned.has(id) && !available.has(id)
                            ? `Unavailable photo ${id}`
                            : (byId.get(id)?.filename ?? `Photo ${id}`)}
                        </span>
                        <button
                          type="button"
                          className="button secondary"
                          aria-label={`Remove assignment ${id}`}
                          onClick={() =>
                            edit({
                              photoIds: chosen.photoIds.filter(
                                (photoId) => photoId !== id,
                              ),
                            })
                          }
                        >
                          Remove assignment
                        </button>
                      </li>
                    ))}
                  </ul>
                  <h3>Add event photos</h3>
                  <label>
                    Search coverage photo filenames
                    <input
                      value={search}
                      onChange={(event) => {
                        setSearch(event.target.value);
                        setShown(50);
                      }}
                    />
                  </label>
                  <p>
                    Showing {Math.min(shown, candidates.length)} of{' '}
                    {candidates.length} candidates. Access is checked again on
                    save. Reload the event to load newly uploaded candidates.
                  </p>
                  <ul
                    className="coverage-assignments"
                    aria-label="Coverage photo candidates"
                  >
                    {candidates.slice(0, shown).map((photo) => (
                      <li key={photo.id}>
                        <span>{photo.filename}</span>
                        <button
                          type="button"
                          className="button secondary"
                          disabled={
                            chosen.photoIds.length >= 50 || references >= 100
                          }
                          aria-label={`Assign ${photo.filename} (${photo.id})`}
                          onClick={() =>
                            edit({ photoIds: [...chosen.photoIds, photo.id] })
                          }
                        >
                          Assign photo
                        </button>
                      </li>
                    ))}
                  </ul>
                  {candidates.length > shown && (
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => setShown(shown + 50)}
                    >
                      Show more coverage candidates
                    </button>
                  )}
                </div>
              )}
            </div>
            {!valid && (
              <p role="alert">
                Use unique nonempty names, targets from 1 to 50, short notes and
                no more than 100 photo references within the metadata limit.
              </p>
            )}
            <button
              className="button"
              type="button"
              disabled={!valid || !dirty}
              onClick={() => void run(true)}
            >
              Save coverage plan
            </button>
          </fieldset>
        </>
      )}
      <button
        className="button secondary"
        type="button"
        disabled={busy}
        onClick={() => void run(false)}
      >
        Refresh saved coverage
      </button>
    </section>
  );
}
