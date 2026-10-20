import { afterEach, describe, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';
import { ATTRIBUTION_HEADER } from '../../packages/shared/src/photo-attribution';
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
  it('includes current published response credits in the ZIP without changing JPEG bytes', async () => {
    const credit = { name: '=Asha, "Studio"', website: 'https://example.test' };
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const response = jpeg();
        if (calls++ === 0)
          response.headers.set(
            ATTRIBUTION_HEADER,
            encodeURIComponent(JSON.stringify(credit)),
          );
        return response;
      }),
    );
    const signal = new AbortController().signal;
    const files = await collectPhotoFiles(photos, signal, () => {});
    const zip = unzipSync(await createGalleryArchive(files, signal));
    expect(Object.keys(zip)).toHaveLength(3);
    expect([...zip[archiveFilename(photos[0]!.filename, 0)]!]).toEqual([
      255, 216, 255, 217,
    ]);
    const csv = new TextDecoder().decode(zip['credits.csv']);
    expect(csv).toContain(archiveFilename(photos[0]!.filename, 0));
    expect(csv).toContain(`"'=Asha, ""Studio"""`);
    expect(csv).not.toContain(archiveFilename(photos[1]!.filename, 1));
  });
  it('ignores stale gallery credit when the current file response has none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jpeg()),
    );
    const stale = photos.map((photo) => ({
      ...photo,
      credit: { name: 'Withdrawn', website: '' },
    }));
    const files = await collectPhotoFiles(
      stale,
      new AbortController().signal,
      () => {},
    );
    expect(files).not.toHaveProperty('credits.csv');
  });
  it.each([
    '%invalid',
    '{}',
    JSON.stringify({ name: 'Credit', website: 'javascript:alert(1)' }),
    JSON.stringify({
      name: 'Credit',
      website: '',
      privateNote: 'must not enter ZIP',
    }),
    'x'.repeat(6001),
  ])('rejects malformed attribution response metadata %s', async (header) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const response = jpeg();
        response.headers.set(ATTRIBUTION_HEADER, header);
        return response;
      }),
    );
    await expect(
      collectPhotoFiles(photos, new AbortController().signal, () => {}),
    ).rejects.toThrow('attribution metadata');
  });
  it('counts the attribution sidecar against the total archive byte budget', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const response = jpeg();
        response.headers.set(
          ATTRIBUTION_HEADER,
          encodeURIComponent(JSON.stringify({ name: 'Studio', website: '' })),
        );
        return response;
      }),
    );
    await expect(
      collectPhotoFiles(photos, new AbortController().signal, () => {}, 8),
    ).rejects.toThrow('include photographer credits');
  });
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
