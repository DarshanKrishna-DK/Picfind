import { randomUUID } from 'node:crypto';
import ICAL from 'ical.js';
import { describe, it, expect } from 'vitest';
import {
  deadlineSnapshot,
  eventDeadlineState,
  exportDeadlineCalendar,
  filteredDeadlines,
  type DeadlineSnapshot,
  type DeadlineFilters,
  type EventDeadline,
} from '../../packages/shared/src/event-deadlines';
const filters: DeadlineFilters = { search: '', state: 'all' };
function fixture() {
  const checkedAt = '2026-10-21T10:00:00.000Z';
  const row: EventDeadline = {
    id: randomUUID(),
    title: 'Gallery',
    archived: false,
    expiresAt: '2026-11-21T10:00:00.000Z',
  };
  const snapshot: DeadlineSnapshot = {
    accountId: 'owner',
    checkedAt,
    events: [row],
  };
  return { row, snapshot };
}
describe('event deadline calendar copies', () => {
  it('distinguishes exact expiry, seven-day boundaries, archived and undated records', () => {
    const { row, snapshot } = fixture();
    expect(
      eventDeadlineState(
        { ...row, expiresAt: snapshot.checkedAt },
        snapshot.checkedAt,
      ),
    ).toBe('expired');
    expect(
      eventDeadlineState(
        { ...row, expiresAt: '2026-10-28T10:00:00.000Z' },
        snapshot.checkedAt,
      ),
    ).toBe('soon');
    expect(
      eventDeadlineState(
        { ...row, expiresAt: '2026-10-28T10:00:00.001Z' },
        snapshot.checkedAt,
      ),
    ).toBe('active');
    expect(
      eventDeadlineState({ ...row, expiresAt: null }, snapshot.checkedAt),
    ).toBe('undated');
    expect(
      eventDeadlineState(
        { ...row, expiresAt: null, archived: true },
        snapshot.checkedAt,
      ),
    ).toBe('archived');
  });
  it('filters using the server check time and stable date/title ordering', () => {
    const { row, snapshot } = fixture();
    snapshot.events.push({
      ...row,
      id: randomUUID(),
      title: 'PORTRAIT soon',
      expiresAt: '2026-10-22T10:00:00.000Z',
    });
    expect(
      filteredDeadlines(snapshot, { search: 'portrait', state: 'soon' }).map(
        (item) => item.title,
      ),
    ).toEqual(['PORTRAIT soon']);
    expect(filteredDeadlines(snapshot, filters)[0]!.title).toBe(
      'PORTRAIT soon',
    );
  });
  it('creates a private transparent instant marker with exact UTC time and stable identity', () => {
    const { row, snapshot } = fixture();
    const output = exportDeadlineCalendar(snapshot, filters, 'none');
    const calendar = new ICAL.Component(ICAL.parse(output.content)),
      component = calendar.getFirstSubcomponent('vevent')!,
      event = new ICAL.Event(component);
    expect(event.startDate.toJSDate().toISOString()).toBe(row.expiresAt);
    expect(event.endDate.toJSDate().toISOString()).toBe(row.expiresAt);
    expect(component.getFirstPropertyValue('class')).toBe('PRIVATE');
    expect(component.getFirstPropertyValue('transp')).toBe('TRANSPARENT');
    expect(component.getAllProperties('attendee')).toHaveLength(0);
    expect(component.getAllProperties('organizer')).toHaveLength(0);
    expect(component.getAllSubcomponents('valarm')).toHaveLength(0);
    const later = exportDeadlineCalendar(
      { ...snapshot, checkedAt: '2026-10-22T10:00:00.000Z' },
      filters,
      'none',
    );
    expect(
      new ICAL.Event(
        new ICAL.Component(ICAL.parse(later.content)).getFirstSubcomponent(
          'vevent',
        )!,
      ).uid,
    ).toBe(event.uid);
  });
  it.each([
    ['day', -86400],
    ['week', -604800],
  ] as const)('parses a %s display alarm independently', (choice, seconds) => {
    const { snapshot } = fixture(),
      output = exportDeadlineCalendar(snapshot, filters, choice);
    const alarm = new ICAL.Component(ICAL.parse(output.content))
      .getFirstSubcomponent('vevent')!
      .getFirstSubcomponent('valarm')!;
    expect(alarm.getFirstPropertyValue('action')).toBe('DISPLAY');
    expect(
      (alarm.getFirstPropertyValue('trigger') as ICAL.Duration).toSeconds(),
    ).toBe(seconds);
    expect(alarm.getFirstPropertyValue('description')).toContain('Gallery');
    expect(output.alarmsOmitted).toBe(0);
  });
  it('omits alarm triggers at or before the check time without dropping the future deadline', () => {
    const { row, snapshot } = fixture();
    row.expiresAt = '2026-10-22T10:00:00.000Z';
    const output = exportDeadlineCalendar(snapshot, filters, 'day');
    expect(output.count).toBe(1);
    expect(output.alarmsOmitted).toBe(1);
    expect(output.content).not.toContain('BEGIN:VALARM');
  });
  it('exports only future active deadlines and rejects an empty or invalid selection', () => {
    const { row, snapshot } = fixture();
    snapshot.events.push(
      { ...row, id: randomUUID(), archived: true },
      { ...row, id: randomUUID(), expiresAt: null },
      { ...row, id: randomUUID(), expiresAt: snapshot.checkedAt },
    );
    expect(exportDeadlineCalendar(snapshot, filters, 'none').count).toBe(1);
    expect(() =>
      exportDeadlineCalendar(
        snapshot,
        { search: '', state: 'expired' },
        'none',
      ),
    ).toThrow('No future');
    expect(() =>
      exportDeadlineCalendar(
        snapshot,
        { search: 'x'.repeat(201), state: 'all' },
        'none',
      ),
    ).toThrow();
    expect(() =>
      deadlineSnapshot.parse({ ...snapshot, events: [row, row] }),
    ).toThrow();
  });
  it('escapes injection-shaped titles and folds Unicode lines to the calendar byte limit', () => {
    const { row, snapshot } = fixture();
    row.title =
      'Portrait, family; \\ details\r\nBEGIN:VEVENT\n' + '界'.repeat(50);
    const output = exportDeadlineCalendar(snapshot, filters, 'day');
    const calendar = new ICAL.Component(ICAL.parse(output.content)),
      event = new ICAL.Event(calendar.getFirstSubcomponent('vevent')!);
    expect(calendar.getAllSubcomponents('vevent')).toHaveLength(1);
    expect(event.summary).toContain('BEGIN:VEVENT');
    for (const line of output.content.split('\r\n'))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });
  it('exports the complete bounded snapshot without paging or truncating calendar events', () => {
    const { row, snapshot } = fixture();
    snapshot.events = Array.from({ length: 500 }, (_, index) => ({
      ...row,
      id: randomUUID(),
      title: `Event ${index}`,
    }));
    const output = exportDeadlineCalendar(snapshot, filters, 'week');
    expect(output.count).toBe(500);
    expect(
      new ICAL.Component(ICAL.parse(output.content)).getAllSubcomponents(
        'vevent',
      ),
    ).toHaveLength(500);
    expect(new TextEncoder().encode(output.content).length).toBeLessThan(
      1000000,
    );
  });
});
