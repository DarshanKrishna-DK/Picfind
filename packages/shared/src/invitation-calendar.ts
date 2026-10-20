import {
  publicInvitationPage,
  type PublicInvitationPage,
} from './event-invitation-page.js';
import { appointmentOccurrences } from './studio-appointments.js';
import { calendarStamp, calendarText, foldCalendarLine } from './ical.js';
import { qrPackOrigin } from './qr-pack.js';

export function invitationInstants(page: PublicInvitationPage) {
  return page.fields.time
    ? appointmentOccurrences(
        `${page.fields.date}T${page.fields.time}`,
        page.fields.timeZone,
      )
    : [];
}
export function invitationDestination(origin: string, eventId: string) {
  qrPackOrigin(origin);
  return `${origin}/invite/${encodeURIComponent(eventId)}`;
}
export function exportInvitationCalendar(
  input: unknown,
  origin: string,
  chosenInstant = '',
) {
  const page = publicInvitationPage.parse(input),
    fields = page.fields,
    target = invitationDestination(origin, page.eventId),
    instants = invitationInstants(page);
  if (page.revision > 2_147_483_647)
    throw new Error(
      'This invitation revision exceeds the calendar format limit.',
    );
  let dateLines: string[];
  if (fields.time) {
    const instant =
      instants.length === 1 ? instants[0]!.instant : chosenInstant;
    if (!instant || !instants.some((value) => value.instant === instant))
      throw new Error(
        'Choose the intended occurrence of this repeated local time before downloading.',
      );
    if (chosenInstant && chosenInstant !== instant)
      throw new Error('The selected time no longer matches this invitation.');
    dateLines = [`DTSTART:${calendarStamp(instant)}`];
  } else {
    if (chosenInstant)
      throw new Error(
        'This invitation has a date but no published start time.',
      );
    const nextDate = new Date(`${fields.date}T00:00:00.000Z`);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    dateLines = [
      `DTSTART;VALUE=DATE:${fields.date.replaceAll('-', '')}`,
      `DTEND;VALUE=DATE:${nextDate.toISOString().slice(0, 10).replaceAll('-', '')}`,
    ];
  }
  const description = [
    ...(fields.host ? [`Hosted by ${fields.host}`] : []),
    fields.time
      ? `Published local start: ${fields.date} ${fields.time} (${fields.timeZone}). No end time was provided.`
      : `Published date: ${fields.date}. No start time was provided.`,
    ...(fields.instructions ? [fields.instructions] : []),
    'Static invitation reminder. Check the published page for changes. This is not an attendance confirmation or admission ticket.',
    target,
  ].join('\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PicFind//Published invitation reminder//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:urn:uuid:${page.eventId}`,
    `DTSTAMP:${calendarStamp(page.publishedAt)}`,
    `LAST-MODIFIED:${calendarStamp(page.publishedAt)}`,
    `SEQUENCE:${page.revision}`,
    ...dateLines,
    `SUMMARY:${calendarText(fields.heading)}`,
    `DESCRIPTION:${calendarText(description)}`,
    ...(fields.venue || fields.address
      ? [
          `LOCATION:${calendarText(
            [fields.venue, fields.address].filter(Boolean).join('\n'),
          )}`,
        ]
      : []),
    `URL:${target}`,
    'CLASS:PUBLIC',
    'STATUS:TENTATIVE',
    'TRANSP:TRANSPARENT',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldCalendarLine).join('\r\n') + '\r\n';
}
