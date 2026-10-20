import { randomUUID } from 'node:crypto';
import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import {
  exportStudioCalendar,
  filterAppointments,
  type ScheduleFilters,
} from '../../packages/shared/src/studio-calendar';
import type {
  AppointmentSchedule,
  AppointmentView,
} from '../../packages/shared/src/studio-appointments';

const filters: ScheduleFilters = {
  search: '',
  status: 'all',
  projectId: '',
  from: '',
  through: '',
};
function fixture() {
  const projectId = randomUUID(),
    now = '2026-10-20T12:34:56.789Z';
  const view: AppointmentView = {
    project: {
      id: projectId,
      name: 'Private wedding project',
      stage: 'booked',
      removalPending: false,
    },
    appointment: {
      id: randomUUID(),
      projectId,
      title: 'Portrait session',
      note: 'Private location instructions',
      startLocal: '2026-11-01T01:30',
      endLocal: '2026-11-01T02:30',
      timeZone: 'America/New_York',
      startAt: '2026-11-01T06:30:00.000Z',
      endAt: '2026-11-01T07:30:00.000Z',
      status: 'scheduled',
      version: 3,
      createdAt: now,
      updatedAt: now,
    },
  };
  const schedule: AppointmentSchedule = {
    accountId: 'owner',
    limit: 300,
    totalCount: 1,
    appointments: [view],
    projects: [view.project!],
  };
  return { schedule, view };
}
function parsed(content: string) {
  return new ICAL.Component(ICAL.parse(content));
}
describe('private studio iCalendar snapshots', () => {
  it('parses exact repeated-hour UTC occurrences and stable saved revisions with an independent parser', () => {
    const { schedule, view } = fixture();
    const output = exportStudioCalendar(schedule, filters);
    const calendar = parsed(output.content),
      component = calendar.getFirstSubcomponent('vevent')!,
      event = new ICAL.Event(component);
    expect(output.count).toBe(1);
    expect(calendar.getFirstPropertyValue('version')).toBe('2.0');
    expect(event.uid).toBe(`urn:uuid:${view.appointment.id}`);
    expect(event.startDate.toJSDate().toISOString()).toBe(
      view.appointment.startAt,
    );
    expect(event.endDate.toJSDate().toISOString()).toBe(view.appointment.endAt);
    expect(component.getFirstPropertyValue('sequence')).toBe(3);
    expect(component.getFirstPropertyValue('status')).toBe('TENTATIVE');
    expect(component.getFirstPropertyValue('class')).toBe('PRIVATE');
    expect(component.getFirstPropertyValue('dtstamp')!.toString()).toBe(
      '2026-10-20T12:34:56Z',
    );
    expect(calendar.hasProperty('method')).toBe(false);
    expect(component.hasProperty('attendee')).toBe(false);
    expect(component.hasProperty('organizer')).toBe(false);
    expect(component.getAllSubcomponents('valarm')).toHaveLength(0);
    expect(
      component.getFirstProperty('dtstart')!.getParameter('tzid'),
    ).toBeUndefined();
    expect(exportStudioCalendar(schedule, filters).content).toBe(
      output.content,
    );
  });
  it('omits project names and private notes unless explicitly included', () => {
    const { schedule, view } = fixture();
    const plain = exportStudioCalendar(schedule, filters).content;
    const plainDescription = new ICAL.Event(
      parsed(plain).getFirstSubcomponent('vevent')!,
    ).description;
    expect(plainDescription).not.toContain('Private wedding project');
    expect(plainDescription).not.toContain('Private location instructions');
    expect(
      new ICAL.Event(parsed(plain).getFirstSubcomponent('vevent')!).description,
    ).toContain('Timezone: America/New_York');
    const included = new ICAL.Event(
      parsed(
        exportStudioCalendar(schedule, filters, true).content,
      ).getFirstSubcomponent('vevent')!,
    );
    expect(included.description).toContain(`Project: ${view.project!.name}`);
    expect(included.description).toContain(
      `Private note: ${view.appointment.note}`,
    );
    view.project = null;
    expect(exportStudioCalendar(schedule, filters, true).content).not.toContain(
      'Private wedding project',
    );
  });
  it('exports a cancellation under the same UID with its new sequence and transparent time', () => {
    const { schedule, view } = fixture();
    const old = new ICAL.Event(
      parsed(
        exportStudioCalendar(schedule, filters).content,
      ).getFirstSubcomponent('vevent')!,
    );
    view.appointment.status = 'cancelled';
    view.appointment.version++;
    const component = parsed(
      exportStudioCalendar(schedule, filters).content,
    ).getFirstSubcomponent('vevent')!;
    expect(new ICAL.Event(component).uid).toBe(old.uid);
    expect(component.getFirstPropertyValue('sequence')).toBe(4);
    expect(component.getFirstPropertyValue('status')).toBe('CANCELLED');
    expect(component.getFirstPropertyValue('transp')).toBe('TRANSPARENT');
  });
  it('escapes text injection without creating properties or extra components and preserves Unicode folding', () => {
    const { schedule, view } = fixture();
    view.appointment.title =
      'Portrait, "family"; C:\\photos\nBEGIN:VEVENT\u0000';
    view.appointment.note =
      '界'.repeat(120) +
      '😀'.repeat(100) +
      '\r\nATTENDEE:mailto:attacker@example.test\rEND:VEVENT\u007f';
    const content = exportStudioCalendar(schedule, filters, true).content;
    const calendar = parsed(content),
      components = calendar.getAllSubcomponents('vevent');
    expect(components).toHaveLength(1);
    expect(components[0]!.hasProperty('attendee')).toBe(false);
    const event = new ICAL.Event(components[0]!);
    expect(event.summary).toBe(view.appointment.title.replace('\u0000', ''));
    expect(event.description).toContain('界'.repeat(120) + '😀'.repeat(100));
    expect(event.description).toContain(
      '\nATTENDEE:mailto:attacker@example.test\nEND:VEVENT',
    );
    for (const line of content.split('\r\n'))
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    expect(content.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/);
    expect(content).toContain('\r\n ');
  });
  it('uses the same saved local-date, status, project and search filters for display and export', () => {
    const { schedule, view } = fixture();
    const matched = {
      ...filters,
      search: 'PRIVATE WEDDING',
      projectId: view.appointment.projectId,
      from: '2026-11-01',
      through: '2026-11-01',
      status: 'scheduled' as const,
    };
    expect(filterAppointments(schedule.appointments, matched)).toHaveLength(1);
    expect(exportStudioCalendar(schedule, matched).count).toBe(1);
    for (const changes of [
      { search: 'missing' },
      { projectId: randomUUID() },
      { status: 'cancelled' as const },
      { from: '2026-11-02', through: '' },
      { through: '2026-10-31' },
    ]) {
      expect(
        filterAppointments(schedule.appointments, { ...filters, ...changes }),
      ).toEqual([]);
      expect(() =>
        exportStudioCalendar(schedule, { ...filters, ...changes }),
      ).toThrow('No saved appointments');
    }
  });
  it('does not include the next local day when an appointment ends exactly at midnight', () => {
    const { schedule, view } = fixture();
    Object.assign(view.appointment, {
      timeZone: 'UTC',
      startLocal: '2026-10-20T23:00',
      endLocal: '2026-10-21T00:00',
      startAt: '2026-10-20T23:00:00.000Z',
      endAt: '2026-10-21T00:00:00.000Z',
    });
    expect(
      filterAppointments(schedule.appointments, {
        ...filters,
        from: '2026-10-21',
      }),
    ).toEqual([]);
    expect(
      exportStudioCalendar(schedule, { ...filters, through: '2026-10-20' })
        .count,
    ).toBe(1);
  });
  it('rejects invalid date ranges, incomplete snapshots, duplicate records and out-of-range calendar revisions', () => {
    const { schedule, view } = fixture();
    const invalid = { ...filters, from: '2026-11-02', through: '2026-11-01' };
    expect(filterAppointments(schedule.appointments, invalid)).toEqual([]);
    expect(() => exportStudioCalendar(schedule, invalid)).toThrow(
      'valid calendar filters',
    );
    expect(() =>
      exportStudioCalendar(
        {
          ...schedule,
          totalCount: 301,
          appointments: Array.from({ length: 300 }, (_, index) => ({
            ...view,
            appointment: {
              ...view.appointment,
              id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
            },
          })),
        },
        filters,
      ),
    ).toThrow('exceeds the loaded limit');
    expect(() =>
      exportStudioCalendar(
        { ...schedule, totalCount: 2, appointments: [view, view] },
        filters,
      ),
    ).toThrow();
    view.appointment.version = 2_147_483_648;
    expect(() => exportStudioCalendar(schedule, filters)).toThrow(
      'revision exceeds',
    );
  });
});
