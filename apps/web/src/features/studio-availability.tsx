import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, HttpError, session } from '../api';
import { ErrorNote, Loading, PageTitle } from '../components/ui';
import { exportNavigationGuard } from '../export-navigation';
import { appointmentOccurrences } from '../../../../packages/shared/src/studio-appointments';
import {
  AVAILABILITY_ACTOR,
  AVAILABILITY_LIMIT,
  availabilityDirectory,
  availabilityResponse,
  availabilityFields,
  blockFields,
  type AvailabilityFields,
  type SavedAvailability,
} from '../../../../packages/shared/src/studio-availability';
import './studio-availability.css';

const root = '/studio/availability';
function blank(): AvailabilityFields {
  return {
    title: '',
    note: '',
    timeZone: 'Asia/Kolkata',
    startLocal: '',
    endLocal: '',
    startAt: '',
    endAt: '',
    active: true,
  };
}
export function StudioAvailability() {
  const account = useQuery({
    queryKey: ['session'],
    queryFn: session,
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  if (account.isPending) return <Loading />;
  if (account.error || !account.data)
    return (
      <ErrorNote
        error={
          account.error ?? new Error('Sign in to manage unavailable time.')
        }
      />
    );
  return <Availability key={account.data.id} accountId={account.data.id} />;
}
function Availability({ accountId }: { accountId: string }) {
  const cache = useQueryClient(),
    key = ['studio-availability', accountId],
    headers = { [AVAILABILITY_ACTOR]: accountId };
  const [selected, setSelected] = useState<SavedAvailability | null>(null),
    [identity, setIdentity] = useState<{ id: string; generation: string }>(
      () => ({
        id: crypto.randomUUID(),
        generation: crypto.randomUUID(),
      }),
    ),
    [draft, setDraft] = useState(blank),
    [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false),
    [error, setError] = useState<unknown>(null),
    [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function read(signal: AbortSignal) {
    const value = availabilityDirectory.parse(
      await api(root, { signal, headers }),
    );
    if (value.accountId !== accountId)
      throw new HttpError(403, 'The signed-in account changed.');
    return value;
  }
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => read(signal),
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  const dirty =
    JSON.stringify(draft) !==
    JSON.stringify(selected ? blockFields(selected) : blank());
  function choose(value: SavedAvailability | null, confirm = true) {
    if (
      confirm &&
      dirty &&
      !window.confirm('Discard the current unavailable-time draft?')
    )
      return;
    setSelected(value);
    setIdentity(
      value
        ? { id: value.id, generation: value.generation }
        : { id: crypto.randomUUID(), generation: crypto.randomUUID() },
    );
    setDraft(value ? blockFields(value) : blank());
    setBlocked(false);
    setError(null);
    setMessage('');
  }
  const startChoices = appointmentOccurrences(draft.startLocal, draft.timeZone),
    endChoices = appointmentOccurrences(draft.endLocal, draft.timeZone),
    fields = {
      ...draft,
      startAt:
        startChoices.length === 1 ? startChoices[0]!.instant : draft.startAt,
      endAt: endChoices.length === 1 ? endChoices[0]!.instant : draft.endAt,
    },
    valid = availabilityFields.safeParse(fields).success,
    latest = query.data?.blocks.find((value) => value.id === selected?.id),
    stale =
      !!selected &&
      !query.error &&
      !!query.data &&
      (!latest ||
        latest.version !== selected.version ||
        latest.generation !== selected.generation),
    cannotSave =
      busy ||
      blocked ||
      stale ||
      query.isFetching ||
      !!query.error ||
      !query.data ||
      !valid;
  async function perform(action: 'save' | 'deactivate' | 'remove' | 'reload') {
    if (pending.current || busy) return;
    if (action === 'save' && cannotSave) return;
    if ((action === 'deactivate' || action === 'remove') && !selected) return;
    if (
      action === 'remove' &&
      !window.confirm('Remove this unavailable-time block?')
    )
      return;
    if (
      (action === 'reload' || action === 'deactivate') &&
      dirty &&
      !window.confirm('Discard the current unavailable-time draft?')
    )
      return;
    const controller = new AbortController(),
      assertActive = exportNavigationGuard(controller);
    pending.current = controller;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      await cache.cancelQueries({ queryKey: key });
      if (action === 'reload') {
        const value = await read(controller.signal);
        assertActive();
        cache.setQueryData(key, value);
        choose(
          value.blocks.find((row) => row.id === selected?.id) ?? null,
          false,
        );
        setMessage('Unavailable time reloaded.');
      } else {
        let saved: SavedAvailability | null = null;
        if (action === 'remove') {
          await api(`${root}/${selected!.id}`, {
            method: 'DELETE',
            headers,
            signal: controller.signal,
            body: JSON.stringify({
              generation: selected!.generation,
              version: selected!.version,
            }),
          });
        } else {
          const value = availabilityResponse.parse(
            await api(`${root}/${identity.id}`, {
              method: 'PUT',
              headers,
              signal: controller.signal,
              body: JSON.stringify({
                ...(action === 'deactivate'
                  ? { ...blockFields(selected!), active: false }
                  : fields),
                generation: identity.generation,
                version: selected?.version ?? 0,
              }),
            }),
          );
          if (
            value.accountId !== accountId ||
            value.block.id !== identity.id ||
            value.block.generation !== identity.generation
          )
            throw new HttpError(
              403,
              'The saved block does not match this account and draft.',
            );
          saved = value.block;
        }
        assertActive();
        const prior =
          cache.getQueryData<ReturnType<typeof availabilityDirectory.parse>>(
            key,
          );
        if (prior && !query.error)
          cache.setQueryData(key, {
            ...prior,
            blocks: [
              ...prior.blocks.filter((row) => row.id !== identity.id),
              ...(saved ? [saved] : []),
            ].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt)),
          });
        choose(saved, false);
        setMessage(
          action === 'remove'
            ? 'Unavailable-time block removed.'
            : action === 'deactivate'
              ? 'Unavailable-time block deactivated.'
              : 'Unavailable-time block saved.',
        );
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure);
        if (
          failure instanceof HttpError &&
          (failure.code === 'AVAILABILITY_CHANGED' || failure.status === 404)
        )
          setBlocked(true);
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (pending.current === controller) pending.current = null;
    }
  }
  if (
    [error, query.error].some(
      (value) =>
        value instanceof HttpError && [401, 403].includes(value.status),
    )
  )
    return <ErrorNote error={error ?? query.error} />;
  return (
    <section className="studio-availability stack">
      <PageTitle title="Unavailable time" eyebrow="Private studio" />
      <p>
        Reserve travel, leave or preparation time. Active blocks and scheduled
        appointments cannot overlap. These private records do not send
        notifications or update an external calendar.
      </p>
      <Link className="button secondary" to="/app/schedule">
        Back to schedule
      </Link>
      <ErrorNote error={query.error} />
      <ErrorNote error={error} />
      {message && <p role="status">{message}</p>}
      {(blocked || stale) && (
        <p role="alert">
          This block changed. Your draft is preserved. Reload before saving
          again.
        </p>
      )}
      <div className="availability-actions">
        <button className="button" disabled={busy} onClick={() => choose(null)}>
          New unavailable-time block
        </button>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => void perform('reload')}
        >
          Reload unavailable time
        </button>
      </div>
      {query.isPending && <Loading />}
      {!query.error && query.data && (
        <section aria-label="Saved unavailable time">
          <p>
            {query.data.blocks.length} retained blocks. New-block limit:{' '}
            {AVAILABILITY_LIMIT}.
          </p>
          {query.data.blocks.length === 0 && (
            <p>No unavailable time is saved.</p>
          )}
          <ul className="availability-list">
            {query.data.blocks.map((value) => (
              <li key={value.id}>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => choose(value)}
                >
                  {value.title}
                </button>
                <span>
                  {value.active ? 'Active' : 'Inactive'} ·{' '}
                  {value.startLocal.replace('T', ' ')} to{' '}
                  {value.endLocal.replace('T', ' ')} ({value.timeZone})
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <form
        className="glass-panel stack"
        onSubmit={(event) => {
          event.preventDefault();
          void perform('save');
        }}
      >
        <h2>{selected ? 'Edit unavailable time' : 'New unavailable time'}</h2>
        <fieldset disabled={busy}>
          <legend>Private block details</legend>
          <label>
            Block title
            <input
              required
              maxLength={120}
              value={draft.title}
              onChange={(event) =>
                setDraft({ ...draft, title: event.target.value })
              }
            />
          </label>
          <label>
            Private block note
            <textarea
              maxLength={1000}
              value={draft.note}
              onChange={(event) =>
                setDraft({ ...draft, note: event.target.value })
              }
            />
          </label>
          <label>
            Block timezone
            <input
              required
              value={draft.timeZone}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  timeZone: event.target.value,
                  startAt: '',
                  endAt: '',
                })
              }
            />
          </label>
          <p>
            Use an IANA timezone such as Asia/Kolkata. Choose both occurrences
            when a clock change repeats a local time.
          </p>
          {(['start', 'end'] as const).map((side) => {
            const choices = side === 'start' ? startChoices : endChoices,
              local = `${side}Local` as const,
              instant = `${side}At` as const,
              label = side === 'start' ? 'Start' : 'End';
            return (
              <div className="stack" key={side}>
                <label>
                  {label} local time
                  <input
                    required
                    type="datetime-local"
                    value={draft[local]}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        [local]: event.target.value,
                        [instant]: '',
                      })
                    }
                  />
                </label>
                {draft[local] && choices.length === 0 && (
                  <p role="alert">
                    {label} local time or timezone is invalid, or this local
                    time does not exist.
                  </p>
                )}
                {choices.length > 1 && (
                  <label>
                    {label} occurrence
                    <select
                      value={draft[instant]}
                      onChange={(event) =>
                        setDraft({ ...draft, [instant]: event.target.value })
                      }
                    >
                      <option value="">Choose an occurrence</option>
                      {choices.map((choice) => (
                        <option value={choice.instant} key={choice.instant}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            );
          })}
          <p>
            Intervals must be longer than zero and no more than 31 days.
            Adjacent reservations are allowed.
          </p>
          {fields.startAt && fields.endAt && (
            <p>
              UTC: {fields.startAt} to {fields.endAt}
            </p>
          )}
          <label className="availability-check">
            <input
              type="checkbox"
              checked={draft.active}
              onChange={(event) =>
                setDraft({ ...draft, active: event.target.checked })
              }
            />
            Reserve this time (active)
          </label>
          <button
            className="button primary"
            disabled={
              cannotSave ||
              (!selected &&
                (query.data?.blocks.length ?? 0) >= AVAILABILITY_LIMIT)
            }
          >
            Save unavailable time
          </button>
        </fieldset>
      </form>
      {selected && (
        <div className="availability-actions">
          <button
            className="button secondary"
            disabled={busy || !selected.active || blocked || stale}
            onClick={() => void perform('deactivate')}
          >
            Deactivate saved block
          </button>
          <button
            className="button danger"
            disabled={busy || blocked || stale}
            onClick={() => void perform('remove')}
          >
            Remove saved block
          </button>
        </div>
      )}
    </section>
  );
}
