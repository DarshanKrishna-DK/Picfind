import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  appointmentFields,
  appointmentOccurrences,
  appointmentWrite,
  appointmentsOverlap,
  localMinute,
} from '../../packages/shared/src/studio-appointments';

describe('timezone-aware studio reservations', () => {
  it('requires an explicit occurrence in a repeated DST hour', () => {
    expect(
      appointmentOccurrences('2026-11-01T01:30', 'America/New_York'),
    ).toEqual([
      {
        instant: '2026-11-01T05:30:00.000Z',
        offsetMinutes: -240,
        label: 'UTC-04:00 (2026-11-01T05:30:00.000Z)',
      },
      {
        instant: '2026-11-01T06:30:00.000Z',
        offsetMinutes: -300,
        label: 'UTC-05:00 (2026-11-01T06:30:00.000Z)',
      },
    ]);
  });
  it('rejects DST gaps and an entirely skipped local day', () => {
    expect(
      appointmentOccurrences('2026-03-08T02:30', 'America/New_York'),
    ).toEqual([]);
    expect(appointmentOccurrences('2011-12-30T12:00', 'Pacific/Apia')).toEqual(
      [],
    );
  });
  it('handles half-hour DST transitions and fractional offsets', () => {
    expect(
      appointmentOccurrences('2026-04-05T01:45', 'Australia/Lord_Howe').map(
        (entry) => entry.offsetMinutes,
      ),
    ).toEqual([660, 630]);
    expect(
      appointmentOccurrences('2026-10-20T09:00', 'Asia/Kathmandu')[0]?.instant,
    ).toBe('2026-10-20T03:15:00.000Z');
    expect(
      appointmentOccurrences('2026-10-20T09:00', 'Asia/Kolkata')[0]?.instant,
    ).toBe('2026-10-20T03:30:00.000Z');
    expect(
      appointmentOccurrences('2026-10-20T09:00', 'UTC')[0]?.offsetMinutes,
    ).toBe(0);
  });
  it.each([
    ['2000-01-01T00:00', 'Pacific/Kiritimati', '1999-12-31T10:00:00.000Z'],
    ['2100-12-31T23:00', 'Pacific/Pago_Pago', '2101-01-01T10:00:00.000Z'],
    ['2011-12-29T12:00', 'Pacific/Apia', '2011-12-29T22:00:00.000Z'],
    ['2011-12-31T12:00', 'Pacific/Apia', '2011-12-30T22:00:00.000Z'],
  ])('resolves supported local boundary %s in %s', (local, zone, instant) => {
    expect(
      appointmentOccurrences(local, zone).map((entry) => entry.instant),
    ).toEqual([instant]);
  });
  it('accepts either explicit half-hour occurrence as a complete write', () => {
    const occurrences = appointmentOccurrences(
      '2026-04-05T01:45',
      'Australia/Lord_Howe',
    );
    for (const occurrence of occurrences) {
      expect(
        appointmentWrite.safeParse({
          projectId: randomUUID(),
          title: 'Repeated half hour',
          note: '',
          startLocal: '2026-04-05T01:45',
          endLocal: '2026-04-05T02:45',
          timeZone: 'Australia/Lord_Howe',
          startAt: occurrence.instant,
          endAt: '2026-04-04T16:15:00.000Z',
          status: 'scheduled',
          version: 0,
        }).success,
      ).toBe(true);
    }
    expect(occurrences).toHaveLength(2);
  });
  it.each([
    '2026-02-29T12:00',
    '2026-01-01T24:00',
    '2026-01-01T12:60',
    '1999-01-01T12:00',
    '2101-01-01T12:00',
  ])('rejects invalid local minute %s', (value) => {
    expect(localMinute.safeParse(value).success).toBe(false);
    expect(appointmentOccurrences(value, 'UTC')).toEqual([]);
  });
  it('requires exact matching UTC instants, bounded duration and a real timezone', () => {
    const fields = {
      projectId: randomUUID(),
      title: 'Portrait session',
      note: '',
      startLocal: '2026-10-20T09:00',
      endLocal: '2026-10-20T10:00',
      timeZone: 'Asia/Kolkata',
      startAt: '2026-10-20T03:30:00.000Z',
      endAt: '2026-10-20T04:30:00.000Z',
      status: 'scheduled',
    };
    expect(appointmentFields.safeParse(fields).success).toBe(true);
    expect(
      appointmentFields.safeParse({
        ...fields,
        startAt: '2026-10-20T09:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(
      appointmentFields.safeParse({ ...fields, timeZone: 'Mars/Base' }).success,
    ).toBe(false);
    expect(
      appointmentFields.safeParse({
        ...fields,
        endLocal: fields.startLocal,
        endAt: fields.startAt,
      }).success,
    ).toBe(false);
    expect(
      appointmentFields.safeParse({
        ...fields,
        endLocal: '2026-10-28T09:00',
        endAt: '2026-10-28T03:30:00.000Z',
      }).success,
    ).toBe(false);
  });
  it('permits adjacent reservations but catches both containment and partial overlap', () => {
    const a = {
      startAt: '2026-10-20T09:00:00.000Z',
      endAt: '2026-10-20T10:00:00.000Z',
    };
    expect(
      appointmentsOverlap(a, {
        startAt: a.endAt,
        endAt: '2026-10-20T11:00:00.000Z',
      }),
    ).toBe(false);
    expect(
      appointmentsOverlap(a, {
        startAt: '2026-10-20T09:30:00.000Z',
        endAt: '2026-10-20T11:00:00.000Z',
      }),
    ).toBe(true);
    expect(
      appointmentsOverlap(a, {
        startAt: '2026-10-20T08:30:00.000Z',
        endAt: '2026-10-20T10:30:00.000Z',
      }),
    ).toBe(true);
  });
});
