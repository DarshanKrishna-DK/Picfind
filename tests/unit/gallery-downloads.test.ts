import { afterEach, describe, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';
import {
  archiveFilename,
  collectPhotoFiles,
  createGalleryArchive,
} from '../../apps/web/src/gallery-downloads';

const photos = [
  { id: 'one', filename: '../../same.jpg', url: '/api/photos/one/file' },
  { id: 'two', filename: '../../same.jpg', url: '/api/photos/two/file' },
];
const jpeg = () =>
  new Response(new Uint8Array([255, 216, 255, 217]), {
    headers: { 'Content-Type': 'image/jpeg' },
  });
afterEach(() => vi.unstubAllGlobals());

describe('device-only gallery downloads', () => {
  it('uses distinct safe JPEG names, including duplicate and path-like filenames', () => {
    const first = archiveFilename('../../photo.png', 0);
    const second = archiveFilename('../../photo.png', 1);
    expect(first).not.toMatch(/[\\/]/);
    expect(first).toMatch(/\.jpg$/);
    expect(first).not.toBe(second);
    expect(archiveFilename('x'.repeat(500), 2).length).toBeLessThan(160);
  });

  it('fetches only the selected photo URLs and reports progress without cloud writes', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jpeg());
    vi.stubGlobal('fetch', fetcher);
    const progress = vi.fn();
    const files = await collectPhotoFiles(
      photos,
      new AbortController().signal,
      progress,
    );
    expect(Object.keys(files)).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [index, call] of fetcher.mock.calls.entries()) {
      expect(call[0]).toBe(photos[index]?.url);
      expect(call[1]).toMatchObject({ credentials: 'include' });
      expect(call[1]).not.toHaveProperty('method', 'POST');
    }
    expect(progress.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('creates a real ZIP with both distinct files', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jpeg()),
    );
    const signal = new AbortController().signal;
    const files = await collectPhotoFiles(photos, signal, () => {});
    const archive = await createGalleryArchive(files, signal);
    const unpacked = unzipSync(archive);
    expect(Object.keys(unpacked)).toHaveLength(2);
    for (const data of Object.values(unpacked))
      expect([...data]).toEqual([255, 216, 255, 217]);
  });

  it('rejects an expired or unavailable photo instead of creating a partial ZIP', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Gone', { status: 403 })),
    );
    await expect(
      collectPhotoFiles(photos, new AbortController().signal, () => {}),
    ).rejects.toThrow();
  });

  it('rejects non-photo responses and empty images', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html>Error</html>', {
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );
    await expect(
      collectPhotoFiles(photos, new AbortController().signal, () => {}),
    ).rejects.toThrow();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array(), {
            headers: { 'Content-Type': 'image/jpeg' },
          }),
      ),
    );
    await expect(
      collectPhotoFiles(photos, new AbortController().signal, () => {}),
    ).rejects.toThrow();
  });

  it('enforces the aggregate byte budget while reading the stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jpeg()),
    );
    await expect(
      collectPhotoFiles(photos, new AbortController().signal, () => {}, 6),
    ).rejects.toThrow();
  });

  it('honors cancellation before fetching or compressing', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    controller.abort();
    await expect(
      collectPhotoFiles(photos, controller.signal, () => {}),
    ).rejects.toThrow();
    await expect(
      createGalleryArchive(
        { 'image.jpg': new Uint8Array([1]) },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
