import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, HttpError, session } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import { dateInZone } from '../../../../packages/shared/src/studio-milestones';
import {
  appointmentFields,
  appointmentOccurrences,
  appointmentSchedule,
  savedAppointment,
  type AppointmentFields,
  type AppointmentSchedule,
  type AppointmentView,
  type SavedAppointment,
} from '../../../../packages/shared/src/studio-appointments';
import './studio-schedule.css';

const headers = (accountId: string) => ({
  'X-PicFind-Studio-Actor': accountId,
});
function blank(): AppointmentFields {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    date = dateInZone(new Date(), timeZone);
  return {
    projectId: '',
    title: '',
    note: '',
    timeZone,
    startLocal: `${date}T09:00`,
    endLocal: `${date}T10:00`,
    startAt: '',
    endAt: '',
    status: 'scheduled',
  };
}
function fieldsOf(row: SavedAppointment): AppointmentFields {
  return {
    projectId: row.projectId,
    title: row.title,
    note: row.note,
    timeZone: row.timeZone,
    startLocal: row.startLocal,
    endLocal: row.endLocal,
    startAt: row.startAt,
    endAt: row.endAt,
    status: row.status,
  };
}
async function readSchedule(accountId: string, signal: AbortSignal) {
  const value = appointmentSchedule.parse(
    await api('/studio/appointments', { signal, headers: headers(accountId) }),
  );
  if (value.accountId !== accountId)
    throw new HttpError(
      403,
      'Your signed-in account changed. Reload the studio.',
    );
  return value;
}
export function StudioSchedule() {
  const account = useQuery({ queryKey: ['session'], queryFn: session });
  if (account.isPending) return <Loading />;
  if (!account.data || account.error)
    return (
      <ErrorNote
        error={account.error ?? new Error('Sign in to view your schedule.')}
      />
    );
  return <Schedule key={account.data.id} accountId={account.data.id} />;
}
function Schedule({ accountId }: { accountId: string }) {
  const query = useQuery({
    queryKey: ['studio-schedule', accountId],
    queryFn: ({ signal }) => readSchedule(accountId, signal),
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  if (query.isPending) return <Loading />;
  if (query.error)
    return (
      <section className="glass-panel">
        <h1>Private schedule</h1>
        <ErrorNote error={query.error} />
        <button className="button" onClick={() => void query.refetch()}>
          Retry schedule
        </button>
      </section>
    );
  return <ScheduleEditor key={accountId} initial={query.data} />;
}
function ScheduleEditor({ initial }: { initial: AppointmentSchedule }) {
  const [schedule, setSchedule] = useState(initial);
  const [selected, setSelected] = useState<AppointmentView | null>(null);
  const [draft, setDraft] = useState<AppointmentFields>(blank);
  const [newId, setNewId] = useState(() => crypto.randomUUID());
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('scheduled');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [denied, setDenied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const startChoices = useMemo(
    () => appointmentOccurrences(draft.startLocal, draft.timeZone),
    [draft.startLocal, draft.timeZone],
  );
  const endChoices = useMemo(
    () => appointmentOccurrences(draft.endLocal, draft.timeZone),
    [draft.endLocal, draft.timeZone],
  );
  const startAt =
    startChoices.length === 1
      ? startChoices[0]!.instant
      : startChoices.some((entry) => entry.instant === draft.startAt)
        ? draft.startAt
        : '';
  const endAt =
    endChoices.length === 1
      ? endChoices[0]!.instant
      : endChoices.some((entry) => entry.instant === draft.endAt)
        ? draft.endAt
        : '';
  const resolved = { ...draft, startAt, endAt };
  const valid = appointmentFields.safeParse(resolved).success;
  function choose(view: AppointmentView | null) {
    setSelected(view);
    setDraft(view ? fieldsOf(view.appointment) : blank());
    setNewId(crypto.randomUUID());
    setConflict(false);
    setConfirmDelete(false);
    setError(null);
    setMessage('');
  }
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      await action(controller.signal);
    } catch (failure) {
      if (controller.signal.aborted) return;
      setError(failure);
      if (
        failure instanceof HttpError &&
        failure.code === 'APPOINTMENT_CHANGED'
      )
        setConflict(true);
      if (failure instanceof HttpError && [401, 403].includes(failure.status)) {
        setDenied(true);
        setSelected(null);
        setDraft(blank());
        setSchedule({
          ...initial,
          appointments: [],
          projects: [],
          totalCount: 0,
        });
      }
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function reload() {
    await run(async (signal) => {
      const latest = await readSchedule(initial.accountId, signal);
      signal.throwIfAborted();
      setSchedule(latest);
      choose(null);
      setDenied(false);
      setMessage('Latest schedule loaded.');
    });
  }
  async function persist(
    fields: AppointmentFields,
    success = 'Private appointment saved.',
  ) {
    if (conflict || denied) return;
    await run(async (signal) => {
      const id = selected?.appointment.id ?? newId;
      const input = appointmentFields.parse(fields);
      const result = await api<{ accountId: string; appointment: unknown }>(
        `/studio/appointments/${id}`,
        {
          method: 'PUT',
          signal,
          headers: headers(initial.accountId),
          body: JSON.stringify({
            ...input,
            version: selected?.appointment.version ?? 0,
          }),
        },
      );
      signal.throwIfAborted();
      if (result.accountId !== initial.accountId)
        throw new HttpError(
          403,
          'Your signed-in account changed. Reload the studio.',
        );
      if (savedAppointment.parse(result.appointment).id !== id)
        throw new Error(
          'The saved appointment does not match this draft. Reload the schedule.',
        );
      const latest = await readSchedule(initial.accountId, signal);
      signal.throwIfAborted();
      setSchedule(latest);
      choose(
        latest.appointments.find((view) => view.appointment.id === id) ?? null,
      );
      setMessage(success);
    });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    await persist(resolved);
  }
  async function remove() {
    if (!selected || !confirmDelete || conflict || denied) return;
    const target = selected.appointment;
    await run(async (signal) => {
      await api(`/studio/appointments/${target.id}`, {
        method: 'DELETE',
        signal,
        headers: headers(initial.accountId),
        body: JSON.stringify({ version: target.version }),
      });
      signal.throwIfAborted();
      setSchedule((current) => ({
        ...current,
        totalCount: current.totalCount - 1,
        appointments: current.appointments.filter(
          (view) => view.appointment.id !== target.id,
        ),
      }));
      choose(null);
      const latest = await readSchedule(initial.accountId, signal);
      signal.throwIfAborted();
      setSchedule(latest);
      setMessage('Appointment removed.');
    });
  }
  if (denied)
    return (
      <section className="glass-panel">
        <h1>Private schedule</h1>
        <ErrorNote error={error} />
        <p>
          Private appointments are hidden until your account is checked again.
        </p>
        <button
          className="button"
          disabled={busy}
          onClick={() => void reload()}
        >
          Reload schedule
        </button>
      </section>
    );
  const inactive =
    !!selected &&
    (!selected.project ||
      selected.project.stage === 'archived' ||
      selected.project.removalPending);
  const projectOptions = new Map(
    schedule.projects.map((project) => [project.id, project.name]),
  );
  for (const view of schedule.appointments)
    projectOptions.set(
      view.appointment.projectId,
      view.project?.name ?? 'Unavailable project',
    );
  const visible = schedule.appointments.filter((view) => {
    const row = view.appointment;
    return (
      (status === 'all' || row.status === status) &&
      (!projectFilter || row.projectId === projectFilter) &&
      (!from || row.endLocal > `${from}T00:00`) &&
      (!to || row.startLocal.slice(0, 10) <= to) &&
      `${row.title} ${row.note} ${view.project?.name ?? ''}`
        .toLowerCase()
        .includes(search.trim().toLowerCase())
    );
  });
  return (
    <section className="glass-panel studio-schedule">
      <h1>Private schedule</h1>
      <p>
        Reserve time for your own projects. Scheduled appointments cannot
        overlap. These records do not send client invitations or reserve an
        external calendar.
      </p>
      <p>
        {schedule.appointments.length} of {schedule.totalCount} appointments
        loaded.
      </p>
      {schedule.totalCount > schedule.limit && (
        <p role="status">
          Remove unused appointments and reload to reveal records beyond this
          bounded view.
        </p>
      )}
      <div className="studio-schedule-actions">
        <button
          className="button"
          disabled={busy || schedule.totalCount >= schedule.limit}
          onClick={() => choose(null)}
        >
          New appointment
        </button>
        <button
          className="button"
          disabled={busy}
          onClick={() => void reload()}
        >
          Reload and discard appointment draft
        </button>
        <Link to="/app/projects">Manage projects</Link>
      </div>
      <ErrorNote error={error} />
      {message && <p role="status">{message}</p>}
      {conflict && (
        <p role="alert">
          Your appointment draft is preserved. Reload the current schedule
          before saving again.
        </p>
      )}
      <div className="studio-schedule-grid">
        <div>
          <label>
            Search appointments
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label>
            Appointment filter
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="scheduled">Scheduled</option>
              <option value="cancelled">Cancelled</option>
              <option value="all">All retained</option>
            </select>
          </label>
          <label>
            Schedule project filter
            <select
              value={projectFilter}
              onChange={(event) => setProjectFilter(event.target.value)}
            >
              <option value="">All projects</option>
              {[...projectOptions].map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            From date
            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label>
            Through date
            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
          <p>
            Date filters use each appointment&apos;s saved timezone and include
            appointments crossing into that range.
          </p>
          {from && to && from > to && (
            <p role="alert">Choose a through date on or after the from date.</p>
          )}
          <p>{visible.length} matching appointments</p>
          <ul className="studio-schedule-list" aria-label="Appointments">
            {visible.map((view) => (
              <li key={view.appointment.id}>
                <button
                  disabled={busy}
                  aria-pressed={
                    selected?.appointment.id === view.appointment.id
                  }
                  onClick={() => choose(view)}
                >
                  <strong>{view.appointment.title}</strong>
                  <span>
                    {view.project?.name ?? 'Unavailable project'}
                    {view.project?.stage === 'archived' ? ' (archived)' : ''}
                  </span>
                  <span>
                    {view.appointment.startLocal.replace('T', ' ')} to{' '}
                    {view.appointment.endLocal.replace('T', ' ')} in{' '}
                    {view.appointment.timeZone}
                  </span>
                  <span>
                    {view.appointment.status === 'scheduled'
                      ? 'Scheduled'
                      : 'Cancelled'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <form onSubmit={(event) => void save(event)}>
          <h2>{selected ? 'Edit appointment' : 'New appointment'}</h2>
          {inactive && (
            <p>
              This project is archived, unavailable or pending removal. You can
              cancel or remove this reservation, but editing and restoration
              require an active owned project.
            </p>
          )}
          <fieldset
            disabled={
              busy ||
              conflict ||
              inactive ||
              (!selected && schedule.totalCount >= schedule.limit)
            }
          >
            <label>
              Appointment project
              <select
                required
                disabled={!!selected}
                value={draft.projectId}
                onChange={(event) =>
                  setDraft({ ...draft, projectId: event.target.value })
                }
              >
                <option value="">Choose a project</option>
                {selected &&
                  !schedule.projects.some(
                    (project) => project.id === draft.projectId,
                  ) && (
                    <option value={draft.projectId}>
                      {selected.project?.name ?? 'Unavailable project'}
                    </option>
                  )}
                {schedule.projects.map((project) => (
                  <option value={project.id} key={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Appointment title
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
              Private appointment note
              <textarea
                rows={3}
                maxLength={1000}
                value={draft.note}
                onChange={(event) =>
                  setDraft({ ...draft, note: event.target.value })
                }
              />
            </label>
            <label>
              Appointment timezone
              <input
                required
                maxLength={100}
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
              Use an IANA timezone such as Asia/Kolkata. Dates from 2000 through
              2100 are supported.
            </p>
            <label>
              Start local time
              <input
                required
                type="datetime-local"
                value={draft.startLocal}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    startLocal: event.target.value,
                    startAt: '',
                  })
                }
              />
            </label>
            {!startChoices.length && (
              <p role="alert">
                This start time or timezone is invalid, or the local time does
                not exist because the clock moves forward.
              </p>
            )}
            {startChoices.length > 1 && (
              <label>
                Start occurrence
                <select
                  required
                  value={startAt}
                  onChange={(event) =>
                    setDraft({ ...draft, startAt: event.target.value })
                  }
                >
                  <option value="">Choose the intended occurrence</option>
                  {startChoices.map((entry) => (
                    <option value={entry.instant} key={entry.instant}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              End local time
              <input
                required
                type="datetime-local"
                value={draft.endLocal}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    endLocal: event.target.value,
                    endAt: '',
                  })
                }
              />
            </label>
            {!endChoices.length && (
              <p role="alert">
                This end time or timezone is invalid, or the local time does not
                exist because the clock moves forward.
              </p>
            )}
            {endChoices.length > 1 && (
              <label>
                End occurrence
                <select
                  required
                  value={endAt}
                  onChange={(event) =>
                    setDraft({ ...draft, endAt: event.target.value })
                  }
                >
                  <option value="">Choose the intended occurrence</option>
                  {endChoices.map((entry) => (
                    <option value={entry.instant} key={entry.instant}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {startAt && endAt && (
              <p>
                Resolved UTC interval: {startAt} to {endAt}. The end must follow
                the start by no more than seven days.
              </p>
            )}
            <label>
              Saved appointment status
              <select
                value={draft.status}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    status: event.target.value as AppointmentFields['status'],
                  })
                }
              >
                <option value="scheduled">Scheduled</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
            <button className="button primary" type="submit" disabled={!valid}>
              Save appointment
            </button>
          </fieldset>
          {selected && (
            <div className="studio-schedule-actions">
              {selected.appointment.status === 'scheduled' ? (
                <button
                  className="button"
                  type="button"
                  disabled={busy || conflict}
                  onClick={() =>
                    void persist(
                      {
                        ...fieldsOf(selected.appointment),
                        status: 'cancelled',
                      },
                      'Saved appointment cancelled. Its time is available again.',
                    )
                  }
                >
                  Cancel saved appointment
                </button>
              ) : (
                <button
                  className="button"
                  type="button"
                  disabled={busy || conflict || inactive}
                  onClick={() =>
                    void persist(
                      {
                        ...fieldsOf(selected.appointment),
                        status: 'scheduled',
                      },
                      'Saved appointment restored.',
                    )
                  }
                >
                  Restore saved appointment
                </button>
              )}
              {!confirmDelete ? (
                <button
                  className="button"
                  type="button"
                  disabled={busy || conflict}
                  onClick={() => setConfirmDelete(true)}
                >
                  Remove appointment
                </button>
              ) : (
                <>
                  <p>
                    Remove this reservation record? The linked project and
                    photos remain.
                  </p>
                  <button
                    className="button"
                    type="button"
                    disabled={busy || conflict}
                    onClick={() => void remove()}
                  >
                    Confirm appointment removal
                  </button>
                  <button
                    className="button"
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmDelete(false)}
                  >
                    Keep appointment
                  </button>
                </>
              )}
            </div>
          )}
        </form>
      </div>
    </section>
  );
}
