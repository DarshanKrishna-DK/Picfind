import { describe, expect, it } from 'vitest';
import {
  compareSelections,
  filterComparedPhotos,
} from '../../packages/shared/src/selection-comparison.js';

const a = { id: 'a', filename: 'same.jpg' };
const b = { id: 'b', filename: 'same.jpg' };
const c = { id: 'c', filename: 'third.jpg' };
const first = {
  id: 'first',
  photoIds: ['a', 'a', 'b', 'gone'],
  photos: [a, a, b],
};
const second = { id: 'second', photoIds: ['b', 'c', 'gone'], photos: [b, c] };

describe('selection comparison', () => {
  it('counts unique photo identities, preserving duplicate filenames', () => {
    expect(compareSelections(first, second)).toEqual({
      photos: [
        { ...a, selectedBy: 'first' },
        { ...b, selectedBy: 'both' },
        { ...c, selectedBy: 'second' },
      ],
      unavailable: 1,
      shared: 1,
    });
  });
  it.each([
    ['all', ['a', 'b', 'c']],
    ['shared', ['b']],
    ['first', ['a']],
    ['second', ['c']],
  ] as const)('filters %s without changing the comparison', (filter, ids) => {
    const result = compareSelections(first, second);
    expect(
      filterComparedPhotos(result.photos, filter).map((p) => p.id),
    ).toEqual(ids);
    expect(result.photos).toHaveLength(3);
  });
  it('omits unavailable IDs and ignores unselected projection entries', () => {
    expect(
      compareSelections(
        { ...first, photos: [a, c] },
        { ...second, photos: [c] },
      ),
    ).toMatchObject({ unavailable: 2, shared: 0 });
  });
  it('rejects comparison of a request with itself', () => {
    expect(() => compareSelections(first, first)).toThrow(
      'Choose two different',
    );
  });
  it('handles empty submissions and does not mutate inputs', () => {
    const before = structuredClone(first);
    const result = compareSelections(first, {
      id: 'empty',
      photoIds: [],
      photos: [],
    });
    expect(result.shared).toBe(0);
    expect(first).toEqual(before);
    expect(
      compareSelections(
        { id: 'empty1', photoIds: [], photos: [] },
        { id: 'empty2', photoIds: [], photos: [] },
      ).photos,
    ).toEqual([]);
  });
});
