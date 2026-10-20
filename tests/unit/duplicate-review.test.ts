import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  DUPLICATE_FILE_LIMIT,
  duplicateReview,
  duplicateGroups,
  duplicateSummary,
  exportDuplicateReview,
  keepOneDuplicateCopy,
  scanDuplicateFiles,
  setDuplicateKeep,
  type DuplicateInput,
} from '../../packages/shared/src/duplicate-review';

const digest = (bytes: ArrayBuffer) =>
  webcrypto.subtle.digest('SHA-256', bytes);
function file(
  name = 'photo.jpg',
  text = 'abc',
  overrides: Partial<DuplicateInput> = {},
): DuplicateInput {
  const buffer = new TextEncoder().encode(text).buffer;
  return {
    name,
    type: 'image/jpeg',
    size: buffer.byteLength,
    lastModified: 1,
    arrayBuffer: vi.fn(async () => buffer),
    ...overrides,
  };
}
const scan = (files: DuplicateInput[]) =>
  scanDuplicateFiles(files, new AbortController().signal, vi.fn(), digest);
describe('local exact-byte duplicate review', () => {
  it('uses real SHA-256, groups renamed copies and distinguishes same-name different bytes', async () => {
    const rows = await scan([
      file(),
      file('copy.jpg'),
      file('photo.jpg', 'xyz'),
    ]);
    expect(rows[0]!.digest).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(rows.every((row) => row.keep)).toBe(true);
    expect(
      duplicateGroups(rows).map((group) => group.map((row) => row.row)),
    ).toEqual([[1, 2], [3]]);
    expect(duplicateSummary(rows)).toEqual({
      groups: 1,
      extraCopies: 1,
      kept: 3,
      excluded: 0,
      excludedBytes: 0,
    });
  });
  it.each([
    { size: 0 },
    { size: DUPLICATE_FILE_LIMIT + 1 },
    { type: 'image/svg+xml' },
    { name: '' },
    { name: 'x'.repeat(256) },
    { lastModified: NaN },
    { lastModified: -1 },
  ])(
    'rejects invalid metadata before reading any bytes: %j',
    async (changes) => {
      const good = file(),
        bad = file('bad.jpg', 'abc', changes);
      await expect(scan([good, bad])).rejects.toThrow('Choose JPEG');
      expect(good.arrayBuffer).not.toHaveBeenCalled();
      expect(bad.arrayBuffer).not.toHaveBeenCalled();
    },
  );
  it('rejects empty, over-count and over-byte batches before reading', async () => {
    const entry = file('photo.jpg', 'abc', { size: DUPLICATE_FILE_LIMIT });
    await expect(scan([])).rejects.toThrow('1 and 100');
    await expect(
      scan(Array.from({ length: 101 }, () => entry)),
    ).rejects.toThrow('1 and 100');
    await expect(scan(Array.from({ length: 33 }, () => entry))).rejects.toThrow(
      '256 MiB',
    );
    expect(entry.arrayBuffer).not.toHaveBeenCalled();
  });
  it('waits for each hash before reading the next file and counts completed hashes only', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = file(),
      second = file('second.jpg');
    const run = scanDuplicateFiles(
      [first, second],
      new AbortController().signal,
      (count) => order.push(`progress-${count}`),
      async (bytes) => {
        order.push('hash');
        await gate;
        return digest(bytes);
      },
    );
    await vi.waitFor(() => expect(order).toEqual(['hash']));
    expect(second.arrayBuffer).not.toHaveBeenCalled();
    release();
    await run;
    expect(order).toEqual(['hash', 'progress-1', 'hash', 'progress-2']);
  });
  it.each(['read', 'hash'])(
    'discards cancellation during %s without reading the next input',
    async (phase) => {
      const controller = new AbortController(),
        progress = vi.fn();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = file(),
        second = file('second.jpg');
      const read = first.arrayBuffer;
      if (phase === 'read')
        first.arrayBuffer = vi.fn(async () => {
          await gate;
          return read();
        });
      const hash = vi.fn(async (bytes: ArrayBuffer) => {
        if (phase === 'hash') await gate;
        return digest(bytes);
      });
      const run = scanDuplicateFiles(
        [first, second],
        controller.signal,
        progress,
        hash,
      );
      const rejected = expect(run).rejects.toMatchObject({
        name: 'AbortError',
      });
      await vi.waitFor(() =>
        expect(
          phase === 'read' ? first.arrayBuffer : hash,
        ).toHaveBeenCalledOnce(),
      );
      controller.abort();
      release();
      await rejected;
      if (phase === 'read') expect(hash).not.toHaveBeenCalled();
      expect(progress).not.toHaveBeenCalled();
      expect(second.arrayBuffer).not.toHaveBeenCalled();
    },
  );
  it('rejects a failed read, changed byte length and invalid digest without a partial report', async () => {
    await expect(
      scan([
        file(),
        file('broken.jpg', 'abc', {
          arrayBuffer: async () => {
            throw new Error('Unreadable');
          },
        }),
      ]),
    ).rejects.toThrow('Unreadable');
    await expect(
      scan([file('changed.jpg', 'abc', { size: 4 })]),
    ).rejects.toThrow('changed');
    await expect(
      scanDuplicateFiles(
        [file()],
        new AbortController().signal,
        vi.fn(),
        async () => new ArrayBuffer(1),
      ),
    ).rejects.toThrow('SHA-256');
  });
  it('does not publish a completed scan after cancellation from its final progress callback', async () => {
    const controller = new AbortController();
    await expect(
      scanDuplicateFiles(
        [file()],
        controller.signal,
        () => controller.abort(),
        digest,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('makes reversible immutable choices while protecting the final copy of every group', async () => {
    const rows = await scan([
      file(),
      file('copy.jpg'),
      file('unique.jpg', 'xyz'),
    ]);
    const one = keepOneDuplicateCopy(rows);
    expect(one.map((row) => row.keep)).toEqual([true, false, true]);
    expect(rows.map((row) => row.keep)).toEqual([true, true, true]);
    expect(() => setDuplicateKeep(one, 1, false)).toThrow('at least one');
    expect(() => setDuplicateKeep(one, 3, false)).toThrow('at least one');
    expect(() => setDuplicateKeep(one, 9, true)).toThrow('not in');
    const alternative = setDuplicateKeep(
      setDuplicateKeep(one, 2, true),
      1,
      false,
    );
    expect(keepOneDuplicateCopy(alternative).map((row) => row.keep)).toEqual([
      false,
      true,
      true,
    ]);
    expect(duplicateSummary(alternative).excludedBytes).toBe(3);
  });
  it('exports all decisions with independent row identities, safe CSV and exact JSON names', async () => {
    const names = ['=SUM(1,2).jpg', '\u2003@formula.jpg', 'quote,"line\n.jpg'];
    const rows = keepOneDuplicateCopy(
      await scan(names.map((name) => file(name))),
    );
    const csv = exportDuplicateReview(rows, 'csv');
    expect(csv).toContain('"\'=SUM(1,2).jpg"');
    expect(csv).toContain('"\'\u2003@formula.jpg"');
    expect(csv).toContain('"quote,""line\n.jpg"');
    const json = JSON.parse(exportDuplicateReview(rows, 'json'));
    expect(json).toMatchObject({
      schema: 1,
      algorithm: 'SHA-256',
      scope: 'exact-file-bytes',
      originalsChanged: false,
    });
    expect(json.items.map((row: { name: string }) => row.name)).toEqual(names);
    expect(json.items.map((row: { decision: string }) => row.decision)).toEqual(
      ['keep', 'exclude-from-selection', 'exclude-from-selection'],
    );
    expect(Object.keys(json.items[0]).sort()).toEqual([
      'decision',
      'digest',
      'modifiedAt',
      'name',
      'row',
      'size',
      'type',
    ]);
  });
  it('refuses tampered, reordered, oversized or zero-retained export metadata', async () => {
    const rows = await scan([file(), file('copy.jpg')]);
    for (const changed of [
      rows.map((row) => ({ ...row, keep: false })),
      [rows[1], rows[0]],
      [{ ...rows[0], digest: 'not-a-digest' }],
      [{ ...rows[0], size: DUPLICATE_FILE_LIMIT + 1 }],
      [{ ...rows[0], content: 'unexpected bytes' }],
    ]) {
      expect(duplicateReview.safeParse(changed).success).toBe(false);
      expect(() =>
        exportDuplicateReview(changed as typeof rows, 'json'),
      ).toThrow();
    }
  });
});
