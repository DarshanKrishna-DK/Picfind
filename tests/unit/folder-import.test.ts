import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  inspectFolder,
  relativePhotoPath,
  folderMappingsSchema,
} from '../../packages/shared/src/folder-import';
import {
  parseUploadQueue,
  uploadQueueKey,
} from '../../packages/shared/src/upload-queue';
import { UploadQueueController } from '../../apps/web/src/features/upload-queue-controller';

function file(path: string, text = path, type = 'image/jpeg') {
  const result = new File([text], path.split('/').at(-1)!, { type });
  Object.defineProperty(result, 'webkitRelativePath', { value: path });
  return result;
}
function fixture() {
  const data = new Map<string, string>();
  const upload = vi.fn(async () => randomUUID());
  const make = () =>
    new UploadQueueController({
      accountId: 'owner',
      eventId: 'event',
      folder: true,
      storage: {
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => {
          data.set(key, value);
        },
        removeItem: (key) => {
          data.delete(key);
        },
      },
      exclusive: async (work) => work(),
      digest: async (input) =>
        createHash('sha256')
          .update(Buffer.from(await input.arrayBuffer()))
          .digest('hex'),
      upload,
      changed: () => {},
    });
  const folders = ['Root/Ceremony', 'Root/Portraits'].map((path) => ({
    path,
    title: path.split('/').at(-1)!,
    collectionId: randomUUID(),
    createCollection: true,
  }));
  return { data, upload, make, folders };
}
describe('folder descriptors and recoverable path-aware queues', () => {
  it('keeps nested equal filenames distinct and reports unsupported files before upload', () => {
    const rows = inspectFolder([
      file('Root/A/photo.jpg'),
      file('Root/B/photo.jpg'),
      file('Root/A/image.raw', 'raw', ''),
      file('Root/B/wrong.png'),
      file('Root/B/empty.jpg', ''),
    ]);
    expect(rows.slice(0, 2).map((row) => [row.folder, row.reason])).toEqual([
      ['Root/A', null],
      ['Root/B', null],
    ]);
    expect(rows.slice(2).map((row) => row.reason)).toEqual([
      'Unsupported file type',
      'Image type does not match its extension',
      'Empty file',
    ]);
  });
  it.each([
    '/Root/p.jpg',
    'Root/../p.jpg',
    'C:/Root/p.jpg',
    'Root\\p.jpg',
    'Root//p.jpg',
    'Root/./p.jpg',
    'Root/\u0000p.jpg',
    'p.jpg',
  ])('rejects unsafe or absent hierarchy %s', (path) =>
    expect(relativePhotoPath.safeParse(path).success).toBe(false),
  );
  it('rejects duplicate paths, basename mismatch and excessive descriptors', () => {
    expect(() =>
      inspectFolder([file('Root/p.jpg'), file('Root/p.jpg', 'different')]),
    ).toThrow(/duplicate/);
    const mismatch = new File(['x'], 'other.jpg', { type: 'image/jpeg' });
    Object.defineProperty(mismatch, 'webkitRelativePath', {
      value: 'Root/p.jpg',
    });
    expect(() => inspectFolder([mismatch])).toThrow(/paths/);
    expect(() =>
      inspectFolder(
        Array.from({ length: 1001 }, (_, i) => file(`Root/${i}.jpg`)),
      ),
    ).toThrow(/1000/);
    expect(
      inspectFolder([
        file('Root/large.jpg', 'x'.repeat(8 * 1024 * 1024 + 1)),
      ])[0]?.reason,
    ).toBe('File exceeds 8 MiB');
  });
  it('shares identical bytes while preserving both folder memberships and no original bytes in storage', async () => {
    const f = fixture(),
      queue = f.make();
    await queue.refresh();
    await queue.prepare(
      [
        file('Root/Ceremony/same.jpg', 'private-bytes'),
        file('Root/Portraits/copy.jpg', 'private-bytes'),
      ],
      f.folders,
    );
    expect(queue.view.queue?.items).toHaveLength(1);
    expect(queue.view.queue?.items[0]?.relativePaths).toEqual([
      'Root/Ceremony/same.jpg',
      'Root/Portraits/copy.jpg',
    ]);
    expect(f.data.get(queue.key)).not.toContain('private-bytes');
    expect(f.upload).not.toHaveBeenCalled();
    await queue.run();
    expect(f.upload).toHaveBeenCalledOnce();
    expect(queue.view.queue?.mode).toBe('complete');
    expect(queue.view.queue?.folders).toEqual(f.folders);
  });
  it('recovers after restart with renamed originals without replacing the reviewed mapping', async () => {
    const f = fixture(),
      first = f.make();
    await first.refresh();
    await first.prepare(
      [file('Root/Ceremony/a.jpg', 'a'), file('Root/Portraits/b.jpg', 'b')],
      f.folders,
    );
    const next = f.make();
    await next.refresh();
    expect(next.view.attached).toBe(0);
    await next.prepare([
      file('Elsewhere/renamed.jpg', 'a'),
      file('Elsewhere/b.jpg', 'b'),
    ]);
    expect(next.view.attached).toBe(2);
    expect(next.view.queue?.folders).toEqual(f.folders);
    await next.run();
    expect(
      f.upload.mock.calls.map(
        (args) => (args as unknown as [File, { name: string }])[1].name,
      ),
    ).toEqual(['a.jpg', 'b.jpg']);
  });
  it('keeps old saved queues compatible and separates folder storage from ordinary batches', async () => {
    const f = fixture(),
      queue = f.make();
    await queue.refresh();
    await queue.prepare([file('Root/a.jpg')]);
    const text = f.data.get(queue.key)!;
    expect(parseUploadQueue(text, 'owner', 'event')?.folders).toBeUndefined();
    expect(uploadQueueKey('owner', 'event', true)).not.toBe(
      uploadQueueKey('owner', 'event'),
    );
    expect(() => parseUploadQueue(text, 'another', 'event')).toThrow(
      /another destination/,
    );
  });
  it('rejects invalid saved memberships and out-of-range mappings', async () => {
    const f = fixture(),
      queue = f.make();
    await queue.refresh();
    await queue.prepare([file('Root/Ceremony/a.jpg')], [f.folders[0]!]);
    const saved = JSON.parse(f.data.get(queue.key)!);
    saved.items[0].relativePaths = ['Other/private.jpg'];
    expect(() =>
      parseUploadQueue(JSON.stringify(saved), 'owner', 'event'),
    ).toThrow(/damaged/);
    expect(
      folderMappingsSchema.safeParse(
        Array.from({ length: 21 }, (_, i) => ({
          ...f.folders[0],
          path: `Root/${i}`,
          collectionId: randomUUID(),
        })),
      ).success,
    ).toBe(false);
  });
});
