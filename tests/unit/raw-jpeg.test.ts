import { describe, expect, it } from 'vitest';
import {
  RAW_MANIFEST_LIMIT,
  applyRawSuggestions,
  decodeRawMapping,
  encodeRawMapping,
  eventJpegs,
  exportRawPairs,
  prepareRawPairs,
  resolveRawPairs,
  type RawPair,
} from '../../packages/shared/src/raw-jpeg';

const file = (path: string, size = 100) => ({
  name: path.split('/').at(-1)!,
  webkitRelativePath: path,
  size,
  lastModified: 1_700_000_000_000,
});
const pair = (path: string): RawPair =>
  prepareRawPairs([file(path)]).entries[0]!;
const photos = [
  { id: 'one', filename: 'IMG_01.JPG' },
  { id: 'two', filename: 'IMG_02.jpeg' },
  { id: 'png', filename: 'IMG_03.png' },
];

describe('local RAW filename pairing without reading or uploading bytes', () => {
  it('retains relative metadata and reports unsupported, empty and invalid entries', () => {
    const result = prepareRawPairs([
      file('day/IMG_01.CR3'),
      file('day/readme.txt'),
      file('day/empty.nef', 0),
      file('../unsafe.arw'),
    ]);
    expect(result.entries).toEqual([
      {
        path: 'day/IMG_01.CR3',
        size: 100,
        modifiedAt: 1_700_000_000_000,
        choice: null,
      },
    ]);
    expect(result.skipped.map((entry) => entry.reason)).toEqual([
      'Not a supported RAW filename.',
      'Empty file or invalid file metadata.',
      'Invalid relative path.',
    ]);
  });
  it('rejects repeated paths rather than losing one original', () => {
    expect(() =>
      prepareRawPairs([file('IMG_01.cr3'), file('IMG_01.cr3')]),
    ).toThrow('same relative path');
  });
  it.each([
    'C:/private/IMG.cr3',
    '/absolute/IMG.cr3',
    'a\\IMG.cr3',
    'a//IMG.cr3',
    './IMG.cr3',
    'a/\nIMG.cr3',
  ])('does not admit unsafe path %s to a portable manifest', (path) => {
    expect(() => prepareRawPairs([file(path)])).toThrow('No supported');
  });
  it('rejects empty and oversized selections without creating partial mappings', () => {
    expect(() => prepareRawPairs([])).toThrow('between 1');
    expect(() =>
      prepareRawPairs(Array.from({ length: 501 }, (_, i) => file(`${i}.txt`))),
    ).toThrow('500');
    expect(() =>
      prepareRawPairs(Array.from({ length: 101 }, (_, i) => file(`${i}.cr3`))),
    ).toThrow('100');
  });
  it('suggests only unique JPEG and RAW basenames using case and Unicode normalization', () => {
    const entries = [pair('A/img_01.cr3'), pair('A/Cafe\u0301.nef')];
    const candidates = [...photos, { id: 'accent', filename: 'CAFÉ.jpg' }];
    expect(
      resolveRawPairs(entries, candidates).map((row) => row.suggestion?.id),
    ).toEqual(['one', 'accent']);
    expect(entries.every((entry) => entry.choice === null)).toBe(true);
    const applied = applyRawSuggestions(entries, candidates);
    expect(
      resolveRawPairs(applied, candidates).map((row) => row.status),
    ).toEqual(['ready', 'ready']);
  });
  it('requires manual resolution for duplicate RAW or JPEG basenames', () => {
    const entries = [pair('A/IMG_01.cr3'), pair('B/IMG_01.nef')];
    expect(
      resolveRawPairs(entries, photos).every((row) => row.suggestion === null),
    ).toBe(true);
    expect(
      resolveRawPairs(
        [pair('IMG_01.cr3')],
        [...photos, { id: 'duplicate', filename: 'img_01.jpg' }],
      )[0]!.suggestion,
    ).toBeNull();
    expect(applyRawSuggestions(entries, photos)).toEqual(entries);
  });
  it('does not use PNGs or fuzzy edited suffixes as JPEG suggestions', () => {
    expect(eventJpegs(photos)).toHaveLength(2);
    expect(
      resolveRawPairs([pair('IMG_03.dng')], photos)[0]!.suggestion,
    ).toBeNull();
    expect(
      resolveRawPairs([pair('IMG_01_edited.cr3')], photos)[0]!.suggestion,
    ).toBeNull();
  });
  it('preserves manual and skipped choices when applying suggestions', () => {
    const entries: RawPair[] = [
      {
        ...pair('different.arw'),
        choice: { photoId: 'one', filename: 'IMG_01.JPG' },
      },
      pair('IMG_01.cr3'),
      { ...pair('IMG_02.cr3'), choice: 'skip' },
    ];
    expect(applyRawSuggestions(entries, photos)).toEqual(entries);
  });
  it('marks all repeated targets as conflicts and refuses CSV until resolved', () => {
    const entries = ['a.cr3', 'b.cr3'].map((path) => ({
      ...pair(path),
      choice: { photoId: 'one', filename: 'IMG_01.JPG' },
    }));
    expect(resolveRawPairs(entries, photos).map((row) => row.status)).toEqual([
      'conflict',
      'conflict',
    ]);
    expect(() => exportRawPairs(entries, photos)).toThrow('2 unresolved');
    entries[1]!.choice = { photoId: 'two', filename: 'IMG_02.jpeg' };
    expect(exportRawPairs(entries, photos).count).toBe(2);
  });
  it('invalidates removed, non-JPEG and renamed targets without changing the saved choice', () => {
    const entries = applyRawSuggestions([pair('IMG_01.cr3')], photos);
    expect(resolveRawPairs(entries, [])[0]!.status).toBe('unavailable');
    expect(
      resolveRawPairs(entries, [{ id: 'one', filename: 'IMG_01.png' }])[0]!
        .status,
    ).toBe('unavailable');
    const renamed = [{ id: 'one', filename: 'retouched.jpg' }];
    expect(resolveRawPairs(entries, renamed)[0]!.status).toBe('renamed');
    expect(() => exportRawPairs(entries, renamed)).toThrow('Review');
    expect(entries[0]!.choice).toEqual({
      photoId: 'one',
      filename: 'IMG_01.JPG',
    });
  });
  it('round-trips an exact scoped mapping and rejects foreign, corrupt and excess metadata', () => {
    const entries = applyRawSuggestions([pair('IMG_01.CR3')], photos);
    const encoded = encodeRawMapping('owner', 'event', entries);
    expect(decodeRawMapping(encoded, 'owner', 'event')).toEqual(entries);
    expect(() => decodeRawMapping(encoded, 'other', 'event')).toThrow(
      'another account',
    );
    expect(() => decodeRawMapping(encoded, 'owner', 'other')).toThrow(
      'another account',
    );
    expect(() => decodeRawMapping('{', 'owner', 'event')).toThrow(
      'not a valid',
    );
    const json = JSON.parse(encoded);
    json.entries[0].imageBytes = 'unexpected';
    expect(() =>
      decodeRawMapping(JSON.stringify(json), 'owner', 'event'),
    ).toThrow('not a valid');
    expect(() =>
      decodeRawMapping(' '.repeat(RAW_MANIFEST_LIMIT + 1), 'owner', 'event'),
    ).toThrow('too large');
    expect(() =>
      decodeRawMapping(
        '"' + 'é'.repeat(RAW_MANIFEST_LIMIT / 2) + '"',
        'owner',
        'event',
      ),
    ).toThrow('too large');
    expect(() =>
      encodeRawMapping('owner', 'event', [entries[0]!, entries[0]!]),
    ).toThrow('invalid metadata');
  });
  it('exports only resolved rows, quotes CSV and neutralizes formula-like names', () => {
    const entries: RawPair[] = [
      {
        ...pair('=RAW, "one".cr3'),
        choice: { photoId: 'photo', filename: ' @SUM(A1).jpg' },
      },
      { ...pair('skip.cr3'), choice: 'skip' },
    ];
    const output = exportRawPairs(entries, [
      { id: 'photo', filename: ' @SUM(A1).jpg' },
    ]);
    expect(output.count).toBe(1);
    expect(output.skipped).toBe(1);
    expect(output.content).toContain(`"'=RAW, ""one"".cr3"`);
    expect(output.content).toContain(`"' @SUM(A1).jpg"`);
    expect(output.content).not.toContain('skip.cr3');
    expect(output.content).toContain('2023-11-14T22:13:20.000Z');
  });
  it('requires at least one ready mapping and rejects inconsistent event projections', () => {
    expect(() => exportRawPairs([], photos)).toThrow('at least one');
    expect(() =>
      exportRawPairs([{ ...pair('skip.cr3'), choice: 'skip' }], photos),
    ).toThrow('at least one');
    expect(() => eventJpegs([photos[0]!, photos[0]!])).toThrow('inconsistent');
  });
});
