import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  coverageItems,
  coverageSnapshot,
  coverageStatus,
  coverageWrite,
  newCoverageAssignments,
  type CoverageCategory,
} from '../../packages/shared/src/event-coverage';

function category(changes: Partial<CoverageCategory> = {}): CoverageCategory {
  return {
    id: randomUUID(),
    label: 'Family portraits',
    target: 2,
    note: '',
    photoIds: [],
    ...changes,
  };
}
describe('explicit event coverage categories', () => {
  it('derives missing, partial and met targets only from available manual assignments', () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const row = category({ photoIds: ids });
    expect(coverageStatus(row, new Set())).toEqual({
      count: 0,
      remaining: 2,
      unavailable: 3,
      status: 'missing',
    });
    expect(coverageStatus(row, new Set([ids[0]!]))).toEqual({
      count: 1,
      remaining: 1,
      unavailable: 2,
      status: 'partial',
    });
    expect(coverageStatus(row, new Set(ids))).toEqual({
      count: 3,
      remaining: 0,
      unavailable: 0,
      status: 'target-met',
    });
  });
  it('treats moving an unavailable reference to another category as a new assignment', () => {
    const id = randomUUID(),
      first = category({ photoIds: [id] }),
      second = category({ label: 'Venue details' });
    expect(
      newCoverageAssignments([first], [{ ...first, note: 'Changed note' }]),
    ).toEqual([]);
    expect(
      newCoverageAssignments(
        [first, second],
        [
          { ...first, photoIds: [] },
          { ...second, photoIds: [id] },
        ],
      ),
    ).toEqual([id]);
  });
  it('enforces category identity, normalized names, per-category and total reference limits', () => {
    const row = category(),
      ids = Array.from({ length: 50 }, () => randomUUID());
    expect(
      coverageItems.safeParse([
        row,
        { ...category(), id: row.id, label: 'Other' },
      ]).success,
    ).toBe(false);
    expect(
      coverageItems.safeParse([row, category({ label: ' FAMILY PORTRAITS ' })])
        .success,
    ).toBe(false);
    expect(
      coverageItems.safeParse([category({ photoIds: [ids[0]!, ids[0]!] })])
        .success,
    ).toBe(false);
    expect(
      coverageItems.safeParse([category({ photoIds: [...ids, randomUUID()] })])
        .success,
    ).toBe(false);
    expect(
      coverageItems.safeParse([
        category({ photoIds: ids }),
        category({ label: 'Details', photoIds: ids }),
      ]).success,
    ).toBe(true);
    expect(
      coverageItems.safeParse([
        category({ photoIds: ids }),
        category({ label: 'Details', photoIds: ids }),
        category({ label: 'Extra', photoIds: [ids[0]!] }),
      ]).success,
    ).toBe(false);
    expect(
      coverageItems.safeParse(
        Array.from({ length: 21 }, (_, index) =>
          category({ label: `Shot ${index}` }),
        ),
      ).success,
    ).toBe(false);
  });
  it.each([
    { target: 0 },
    { target: 51 },
    { target: 1.5 },
    { note: 'a'.repeat(201) },
    { label: '' },
    { label: 'a'.repeat(81) },
  ])('rejects invalid category %j', (changes) => {
    expect(
      coverageWrite.safeParse({ items: [category(changes)], version: 0 })
        .success,
    ).toBe(false);
  });
  it('bounds UTF-8 metadata bytes even for individually valid Unicode strings', () => {
    const rows = Array.from({ length: 20 }, (_, index) =>
      category({ label: `Shot ${index}`, note: '界'.repeat(200) }),
    );
    expect(coverageItems.safeParse(rows).success).toBe(false);
  });
  it('rejects malformed snapshot versions and unrelated or duplicate available IDs', () => {
    const id = randomUUID();
    const snapshot = {
      accountId: 'owner',
      eventId: randomUUID(),
      editable: true,
      plan: {
        version: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        items: [category({ photoIds: [id] })],
      },
      availableIds: [id],
    };
    expect(coverageSnapshot.safeParse(snapshot).success).toBe(true);
    expect(
      coverageSnapshot.safeParse({ ...snapshot, availableIds: [randomUUID()] })
        .success,
    ).toBe(false);
    expect(
      coverageSnapshot.safeParse({ ...snapshot, availableIds: [id, id] })
        .success,
    ).toBe(false);
    expect(
      coverageSnapshot.safeParse({
        ...snapshot,
        plan: { ...snapshot.plan, version: 0 },
      }).success,
    ).toBe(false);
    expect(
      coverageSnapshot.safeParse({
        ...snapshot,
        plan: { ...snapshot.plan, updatedAt: null },
      }).success,
    ).toBe(false);
  });
});
