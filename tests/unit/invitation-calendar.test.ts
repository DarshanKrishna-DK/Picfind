import { randomUUID } from 'node:crypto';
import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import {
  blankInvitationPage,
  type PublicInvitationPage,
} from '../../packages/shared/src/event-invitation-page';
import {
  exportInvitationCalendar,
  invitationDestination,
} from '../../packages/shared/src/invitation-calendar';

const origin = 'https://picfind.example.test';
function fixture(): PublicInvitationPage {
  return {
    eventId: randomUUID(),
    revision: 3,
    publishedAt: '2026-10-21T10:11:12.345Z',
    fields: {
      ...blankInvitationPage(),
      heading: 'Our celebration',
      date: '2026-12-31',
      host: 'Host family',
      venue: 'Garden room',
      address: 'North entrance',
      instructions: 'Arrive together.',
    },
  };
}
function parse(content: string) {
  const root = new ICAL.Component(ICAL.parse(content)),
    component = root.getFirstSubcomponent('vevent')!;
  return { root, component, event: new ICAL.Event(component) };
}
describe('published invitation calendar reminders', () => {
  it.each([
    ['2026-12-31', '2027-01-01'],
    ['2028-02-29', '2028-03-01'],
    ['2100-12-31', '2101-01-01'],
  ])('exports an all-day %s with exclusive end %s', (date, next) => {
    const page = fixture();
    page.fields.date = date;
    const { event, component, root } = parse(
      exportInvitationCalendar(page, origin),
    );
    expect(event.startDate.isDate).toBe(true);
    expect(event.startDate.toString()).toBe(date);
    expect(event.endDate.toString()).toBe(next);
    expect(event.uid).toBe(`urn:uuid:${page.eventId}`);
    expect(component.getFirstPropertyValue('sequence')).toBe(3);
    expect(component.getFirstPropertyValue('url')).toBe(
      `${origin}/invite/${page.eventId}`,
    );
    expect(component.getFirstPropertyValue('class')).toBe('PUBLIC');
    expect(component.getFirstPropertyValue('status')).toBe('TENTATIVE');
    expect(component.getFirstPropertyValue('transp')).toBe('TRANSPARENT');
    expect(root.hasProperty('method')).toBe(false);
    expect(component.hasProperty('attendee')).toBe(false);
    expect(component.hasProperty('organizer')).toBe(false);
    expect(component.getAllSubcomponents('valarm')).toHaveLength(0);
  });
  it('resolves the declared timezone without inventing an end time', () => {
    const page = fixture();
    Object.assign(page.fields, {
      date: '2026-12-31',
      time: '23:30',
      timeZone: 'Asia/Kolkata',
    });
    const content = exportInvitationCalendar(page, origin),
      { event, component } = parse(content);
    expect(event.startDate.toJSDate().toISOString()).toBe(
      '2026-12-31T18:00:00.000Z',
    );
    expect(component.hasProperty('dtend')).toBe(false);
    expect(component.hasProperty('duration')).toBe(false);
    expect(event.description).toContain('No end time was provided.');
    expect(exportInvitationCalendar(page, origin)).toBe(content);
    expect(() =>
      exportInvitationCalendar(page, origin, '2026-12-31T19:00:00.000Z'),
    ).toThrow(/no longer matches/);
  });
  it('requires an explicit valid occurrence when a local hour repeats', () => {
    const page = fixture();
    Object.assign(page.fields, {
      date: '2026-11-01',
      time: '01:30',
      timeZone: 'America/New_York',
    });
    expect(() => exportInvitationCalendar(page, origin)).toThrow(/occurrence/);
    for (const instant of [
      '2026-11-01T05:30:00.000Z',
      '2026-11-01T06:30:00.000Z',
    ])
      expect(
        parse(exportInvitationCalendar(page, origin, instant))
          .event.startDate.toJSDate()
          .toISOString(),
      ).toBe(instant);
    expect(() =>
      exportInvitationCalendar(page, origin, '2026-11-01T07:30:00.000Z'),
    ).toThrow(/occurrence/);
    Object.assign(page.fields, { date: '2026-03-08', time: '02:30' });
    expect(() => exportInvitationCalendar(page, origin)).toThrow();
  });
  it('preserves literal Unicode text without creating extra calendar properties', () => {
    const page = fixture();
    page.fields.heading = 'Celebration, friends; family \\ साथ 🎉';
    page.fields.instructions =
      'Welcome 世界 '.repeat(50) +
      '\r\nATTENDEE:mailto:outside@example.test\u0000';
    const content = exportInvitationCalendar(page, origin),
      { root, component, event } = parse(content);
    expect(event.summary).toBe(page.fields.heading);
    expect(event.description).toContain(
      '\nATTENDEE:mailto:outside@example.test',
    );
    expect(event.description).not.toContain('\u0000');
    expect(root.getAllSubcomponents('vevent')).toHaveLength(1);
    expect(component.hasProperty('attendee')).toBe(false);
    for (const line of content.split('\r\n'))
      expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(75);
    expect(content.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/);
  });
  it('rejects private fields, impossible dates and unsupported revisions', () => {
    const page = fixture();
    for (const input of [
      { ...page, draft: page.fields },
      { ...page, receiptId: randomUUID() },
      { ...page, revision: 2_147_483_648 },
      { ...page, fields: { ...page.fields, date: '2026-02-30' } },
    ])
      expect(() => exportInvitationCalendar(input, origin)).toThrow();
    expect(() =>
      exportInvitationCalendar(page, origin, '2026-12-31T00:00:00.000Z'),
    ).toThrow(/no published start time/);
  });
  it.each([
    'http://outside.example',
    'https://name:password@example.test',
    'https://example.test/path',
    'https://example.test?query=1',
    'https://example.test#fragment',
    'javascript:alert(1)',
  ])('rejects unsafe export origin %s', (value) => {
    expect(() => exportInvitationCalendar(fixture(), value)).toThrow();
  });
  it('permits a local preview with an explicit loopback link', () => {
    const page = fixture();
    expect(invitationDestination('http://127.0.0.1:5173', page.eventId)).toBe(
      `http://127.0.0.1:5173/invite/${page.eventId}`,
    );
  });
});
