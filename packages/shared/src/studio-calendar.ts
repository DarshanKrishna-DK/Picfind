import { z } from 'zod';
import {
  appointmentSchedule,
  type AppointmentView,
} from './studio-appointments.js';

const optionalDate = z.union([z.literal(''), z.iso.date()]);
export const scheduleFilters = z
  .object({
    search: z.string().max(1000),
    status: z.enum(['scheduled', 'cancelled', 'all']),
    projectId: z.union([z.literal(''), z.uuid()]),
    from: optionalDate,
    through: optionalDate,
  })
  .strict()
  .refine(
    (filters) =>
      !filters.from || !filters.through || filters.from <= filters.through,
  );
export type ScheduleFilters = z.infer<typeof scheduleFilters>;
export function filterAppointments(
  appointments: readonly AppointmentView[],
  filters: ScheduleFilters,
) {
  if (!scheduleFilters.safeParse(filters).success) return [];
  const search = filters.search.trim().toLowerCase();
  return appointments.filter(
    ({ appointment, project }) =>
      (filters.status === 'all' || appointment.status === filters.status) &&
      (!filters.projectId || appointment.projectId === filters.projectId) &&
      (!filters.from || appointment.endLocal > `${filters.from}T00:00`) &&
      (!filters.through ||
        appointment.startLocal.slice(0, 10) <= filters.through) &&
      `${appointment.title} ${appointment.note} ${project?.name ?? ''}`
        .toLowerCase()
        .includes(search),
  );
}
function textValue(value: string) {
  const escaped = value.replaceAll('\\', '\\\\').replace(/\r\n|\r|\n/g, '\\n');
  return [...escaped]
    .filter((point) => {
      const code = point.codePointAt(0)!;
      return (code >= 32 && code !== 127) || code === 9;
    })
    .join('')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,');
}
function fold(line: string) {
  const encoder = new TextEncoder();
  let result = '',
    bytes = 0;
  for (const point of line) {
    const length = encoder.encode(point).byteLength;
    if (bytes + length > 75) {
      result += '\r\n ';
      bytes = 1;
    }
    result += point;
    bytes += length;
  }
  return result;
}
function stamp(value: string) {
  return new Date(value)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}
export function exportStudioCalendar(
  input: unknown,
  filters: ScheduleFilters,
  includePrivateDetails = false,
) {
  const schedule = appointmentSchedule.parse(input);
  if (schedule.totalCount > schedule.appointments.length)
    throw new Error(
      'The schedule exceeds the loaded limit. Remove unused records and reload before exporting a complete filtered calendar.',
    );
  if (!scheduleFilters.safeParse(filters).success)
    throw new Error(
      'Choose valid calendar filters and a through date on or after the from date.',
    );
  const selected = filterAppointments(schedule.appointments, filters);
  if (!selected.length)
    throw new Error(
      'No saved appointments match these filters. No calendar file was created.',
    );
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PicFind//Private studio schedule//EN',
    'CALSCALE:GREGORIAN',
  ];
  for (const { appointment: row, project } of selected) {
    if (row.version > 2_147_483_647)
      throw new Error(
        'An appointment revision exceeds the calendar format limit. No calendar file was created.',
      );
    const description = [
      `Entered local time: ${row.startLocal} to ${row.endLocal}`,
      `Timezone: ${row.timeZone}`,
      ...(includePrivateDetails && project ? [`Project: ${project.name}`] : []),
      ...(includePrivateDetails && row.note
        ? [`Private note: ${row.note}`]
        : []),
    ].join('\n');
    lines.push(
      'BEGIN:VEVENT',
      `UID:urn:uuid:${row.id}`,
      `DTSTAMP:${stamp(row.updatedAt)}`,
      `CREATED:${stamp(row.createdAt)}`,
      `LAST-MODIFIED:${stamp(row.updatedAt)}`,
      `SEQUENCE:${row.version}`,
      `DTSTART:${stamp(row.startAt)}`,
      `DTEND:${stamp(row.endAt)}`,
      `SUMMARY:${textValue(row.title)}`,
      `DESCRIPTION:${textValue(description)}`,
      'CLASS:PRIVATE',
      `STATUS:${row.status === 'cancelled' ? 'CANCELLED' : 'TENTATIVE'}`,
      `TRANSP:${row.status === 'cancelled' ? 'TRANSPARENT' : 'OPAQUE'}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return {
    content: lines.map(fold).join('\r\n') + '\r\n',
    count: selected.length,
  };
}
