import { z } from 'zod';
import { calendarText, foldCalendarLine, calendarStamp } from './ical.js';

export const EVENT_DEADLINE_LIMIT = 500;
export const DEADLINE_ACTOR = 'X-PicFind-Deadline-Actor';
export const eventDeadline = z
  .object({
    id: z.uuid(),
    title: z.string().min(1).max(120),
    archived: z.boolean(),
    expiresAt: z.iso.datetime().nullable(),
  })
  .strict();
export type EventDeadline = z.infer<typeof eventDeadline>;
export const deadlineSnapshot = z
  .object({
    accountId: z.string().min(1),
    checkedAt: z.iso.datetime(),
    events: z.array(eventDeadline).max(EVENT_DEADLINE_LIMIT),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.events.map((row) => row.id)).size === value.events.length,
  );
export type DeadlineSnapshot = z.infer<typeof deadlineSnapshot>;
export const deadlineFilters = z
  .object({
    search: z.string().max(200),
    state: z.enum(['all', 'soon', 'active', 'expired', 'archived', 'undated']),
  })
  .strict();
export type DeadlineFilters = z.infer<typeof deadlineFilters>;
export const calendarAlarm = z.enum(['none', 'day', 'week']);
export type CalendarAlarm = z.infer<typeof calendarAlarm>;
export function eventDeadlineState(row: EventDeadline, checkedAt: string) {
  if (row.archived) return 'archived' as const;
  if (!row.expiresAt) return 'undated' as const;
  const remaining = Date.parse(row.expiresAt) - Date.parse(checkedAt);
  if (remaining <= 0) return 'expired' as const;
  return remaining <= 7 * 86_400_000 ? ('soon' as const) : ('active' as const);
}
export function filteredDeadlines(
  snapshot: DeadlineSnapshot,
  filters: DeadlineFilters,
) {
  const parsed = deadlineFilters.parse(filters);
  const search = parsed.search.trim().toLowerCase();
  return snapshot.events
    .filter(
      (row) =>
        (parsed.state === 'all' ||
          eventDeadlineState(row, snapshot.checkedAt) === parsed.state) &&
        row.title.toLowerCase().includes(search),
    )
    .sort(
      (a, b) =>
        (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) -
          (b.expiresAt ? Date.parse(b.expiresAt) : Infinity) ||
        a.title.localeCompare(b.title) ||
        a.id.localeCompare(b.id),
    );
}
export function exportDeadlineCalendar(
  input: unknown,
  filters: DeadlineFilters,
  alarmChoice: CalendarAlarm,
) {
  const snapshot = deadlineSnapshot.parse(input),
    alarm = calendarAlarm.parse(alarmChoice);
  const selected = filteredDeadlines(snapshot, filters).filter(
    (row): row is EventDeadline & { expiresAt: string } =>
      !row.archived &&
      row.expiresAt !== null &&
      Date.parse(row.expiresAt) > Date.parse(snapshot.checkedAt),
  );
  if (!selected.length)
    throw new Error(
      'No future active event deadlines match these filters. No calendar file was created.',
    );
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PicFind//Private event access deadlines//EN',
    'CALSCALE:GREGORIAN',
  ];
  let alarmsOmitted = 0;
  for (const row of selected) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:picfind-access-${row.id}@picfind.local`,
      `DTSTAMP:${calendarStamp(snapshot.checkedAt)}`,
      `DTSTART:${calendarStamp(row.expiresAt)}`,
      `SUMMARY:${calendarText(`Event access ends: ${row.title}`)}`,
      `DESCRIPTION:${calendarText('Review the event in PicFind for current availability. This access deadline is not a physical deletion guarantee. Calendar copies do not update automatically.')}`,
      'CLASS:PRIVATE',
      'TRANSP:TRANSPARENT',
      'STATUS:CONFIRMED',
    );
    if (alarm !== 'none') {
      const days = alarm === 'day' ? 1 : 7;
      if (
        Date.parse(row.expiresAt) - days * 86_400_000 >
        Date.parse(snapshot.checkedAt)
      ) {
        lines.push(
          'BEGIN:VALARM',
          'ACTION:DISPLAY',
          `TRIGGER:-P${days}D`,
          `DESCRIPTION:${calendarText(`Review event access: ${row.title}`)}`,
          'END:VALARM',
        );
      } else alarmsOmitted++;
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  const content = lines.map(foldCalendarLine).join('\r\n') + '\r\n';
  if (new TextEncoder().encode(content).length > 1_000_000)
    throw new Error(
      'This calendar exceeds the export size limit. Narrow the event filters.',
    );
  return { content, count: selected.length, alarmsOmitted };
}
