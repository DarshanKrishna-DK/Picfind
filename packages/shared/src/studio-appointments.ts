import { z } from 'zod';
import { projectStage } from './studio-projects.js';

export const APPOINTMENT_LIMIT = 300;
export const PROJECT_APPOINTMENT_LIMIT = 30;
export const appointmentZone = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((timeZone) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone });
      return !/^[+-]/.test(timeZone);
    } catch {
      return false;
    }
  }, 'Choose an IANA timezone.');
export const localMinute = z
  .string()
  .regex(/^(?:20\d\d|2100)-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d$/)
  .refine(
    (value) => z.iso.date().safeParse(value.slice(0, 10)).success,
    'Enter a real local date and time between 2000 and 2100.',
  );

function zoneFormatter(timeZone: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
function localParts(stamp: number, formatter: Intl.DateTimeFormat) {
  const parts = formatter.formatToParts(stamp);
  const part = (type: string) =>
    parts.find((entry) => entry.type === type)!.value;
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
}
export function appointmentOccurrences(local: string, timeZone: string) {
  if (
    !localMinute.safeParse(local).success ||
    !appointmentZone.safeParse(timeZone).success
  )
    return [];
  const nominal = Date.parse(`${local}:00.000Z`),
    candidates = new Map<string, number>(),
    formatter = zoneFormatter(timeZone);
  // Sample both sides of nearby transitions, then verify each candidate by round trip.
  // This handles gaps, repeated hours, half-hour transitions and skipped dates.
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    const sampled = nominal + hours * 3_600_000;
    const offset = Date.parse(`${localParts(sampled, formatter)}Z`) - sampled;
    const candidate = nominal - offset;
    if (localParts(candidate, formatter) === `${local}:00`)
      candidates.set(new Date(candidate).toISOString(), offset / 60_000);
  }
  return [...candidates]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([instant, offsetMinutes]) => {
      const absolute = Math.abs(offsetMinutes),
        sign = offsetMinutes < 0 ? '-' : '+';
      const offset = `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
      return { instant, offsetMinutes, label: `${offset} (${instant})` };
    });
}
const rawFields = z
  .object({
    projectId: z.uuid(),
    title: z.string().trim().min(1).max(120),
    note: z.string().trim().max(1000),
    startLocal: localMinute,
    endLocal: localMinute,
    timeZone: appointmentZone,
    startAt: z.iso.datetime(),
    endAt: z.iso.datetime(),
    status: z.enum(['scheduled', 'cancelled']),
  })
  .strict();
export function validScheduleInterval(
  value: Pick<
    z.infer<typeof rawFields>,
    'startAt' | 'endAt' | 'startLocal' | 'endLocal' | 'timeZone'
  >,
  maxDays = 7,
) {
  const start = Date.parse(value.startAt),
    end = Date.parse(value.endAt);
  return (
    end > start &&
    end - start <= maxDays * 86_400_000 &&
    appointmentOccurrences(value.startLocal, value.timeZone).some(
      (entry) => entry.instant === value.startAt,
    ) &&
    appointmentOccurrences(value.endLocal, value.timeZone).some(
      (entry) => entry.instant === value.endAt,
    )
  );
}
const validInterval = (value: z.infer<typeof rawFields>) =>
  validScheduleInterval(value);
export const appointmentFields = rawFields.refine(
  validInterval,
  'Choose valid timezone occurrences and an end after the start, no more than seven days later.',
);
export type AppointmentFields = z.infer<typeof appointmentFields>;
export const appointmentWrite = rawFields
  .extend({
    version: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
  })
  .strict()
  .refine(validInterval);
export const savedAppointment = rawFields
  .extend({
    id: z.uuid(),
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .refine(validInterval)
  .refine(
    (value) => Date.parse(value.createdAt) <= Date.parse(value.updatedAt),
  );
export type SavedAppointment = z.infer<typeof savedAppointment>;
const project = z
  .object({
    id: z.uuid(),
    name: z.string().min(1).max(100),
    stage: projectStage,
    removalPending: z.boolean(),
  })
  .strict();
export const appointmentView = z
  .object({ appointment: savedAppointment, project: project.nullable() })
  .strict()
  .refine(
    (view) => !view.project || view.project.id === view.appointment.projectId,
  );
export type AppointmentView = z.infer<typeof appointmentView>;
export const appointmentSchedule = z
  .object({
    accountId: z.string().min(1),
    limit: z.literal(APPOINTMENT_LIMIT),
    totalCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    appointments: z.array(appointmentView).max(APPOINTMENT_LIMIT),
    projects: z
      .array(
        project.refine(
          (value) => value.stage !== 'archived' && !value.removalPending,
        ),
      )
      .max(200),
  })
  .strict()
  .refine(
    (value) =>
      value.appointments.length === Math.min(value.limit, value.totalCount) &&
      new Set(value.appointments.map((entry) => entry.appointment.id)).size ===
        value.appointments.length &&
      new Set(value.projects.map((entry) => entry.id)).size ===
        value.projects.length,
  );
export type AppointmentSchedule = z.infer<typeof appointmentSchedule>;
export function appointmentsOverlap(
  a: Pick<AppointmentFields, 'startAt' | 'endAt'>,
  b: Pick<AppointmentFields, 'startAt' | 'endAt'>,
) {
  return (
    Date.parse(a.startAt) < Date.parse(b.endAt) &&
    Date.parse(b.startAt) < Date.parse(a.endAt)
  );
}
export function onlyCancels(
  current: SavedAppointment,
  fields: AppointmentFields,
) {
  return (
    fields.status === 'cancelled' &&
    (Object.keys(rawFields.shape) as (keyof AppointmentFields)[]).every(
      (key) => key === 'status' || fields[key] === current[key],
    )
  );
}
