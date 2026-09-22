import { describe, expect, it, vi } from 'vitest';
import { createCloudFileReader } from '../../apps/api/src/cloud-file-reader.js';
import { MAX_INPUT_BYTES } from '../../apps/api/src/images.js';

describe('bounded cloud downloads without network', () => {
  it.each(['drive', 'box', 'onedrive'] as const)(
    'uses %s metadata and never forwards OAuth to signed CDN URLs',
    async (provider) => {
      const cdn =
        provider === 'drive'
          ? 'https://photos.googleusercontent.com/photo'
          : provider === 'box'
            ? 'https://dl.boxcloud.com/photo'
            : 'https://photos.1drv.com/photo';
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json({ name: 'photo.jpg', size: 3, mimeType: 'image/jpeg' }),
        )
        .mockResolvedValueOnce(
          new Response(null, { status: 302, headers: { location: cdn } }),
        )
        .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
      const guard = vi.fn(async () => {});
      const photo = await createCloudFileReader(fetcher)(
        provider,
        'secret',
        'file-id',
        guard,
      );
      expect(photo.bytes).toEqual(Buffer.from([1, 2, 3]));
      expect(fetcher.mock.calls[0]![1]?.headers).toEqual({
        Authorization: 'Bearer secret',
      });
      expect(fetcher.mock.calls[2]![1]?.headers).toBeUndefined();
      expect(guard).toHaveBeenCalledTimes(3);
    },
  );
  it('reads Dropbox temporary links without any source write operations', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          metadata: { name: 'photo.jpg' },
          link: 'https://dl.dropboxusercontent.com/photo',
        }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1])));
    await createCloudFileReader(fetcher)('dropbox', 'secret', 'id:123');
    expect(fetcher.mock.calls[0]![0]).toBe(
      'https://api.dropboxapi.com/2/files/get_temporary_link',
    );
    expect(fetcher.mock.calls[0]![1]?.body).toBe(
      JSON.stringify({ path: 'id:123' }),
    );
    expect(fetcher.mock.calls[1]![1]?.headers).toBeUndefined();
  });
  it.each([
    'http://dl.boxcloud.com/photo',
    'https://boxcloud.com.evil.test/photo',
    'https://127.0.0.1/photo',
    'https://user:secret@dl.boxcloud.com/photo',
  ])('rejects unsafe redirect %s', async (location) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ name: 'photo.jpg' }))
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location } }),
      );
    await expect(
      createCloudFileReader(fetcher)('box', 'secret', '123'),
    ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects oversized streaming responses even with no content-length header', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ name: 'photo.jpg' }))
      .mockResolvedValueOnce(new Response(new Uint8Array(MAX_INPUT_BYTES + 1)));
    await expect(
      createCloudFileReader(fetcher)('box', 'secret', '123'),
    ).rejects.toMatchObject({ code: 'PHOTO_TOO_LARGE' });
  });
  it('stops before a download when the lease guard fails', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ name: 'photo.jpg' }));
    let calls = 0;
    await expect(
      createCloudFileReader(fetcher)('box', 'secret', '123', async () => {
        if (++calls === 2) throw new Error('Lease lost');
      }),
    ).rejects.toThrow('Lease lost');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('requires a supported Drive image and bounded source id before download', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ name: 'document', mimeType: 'application/pdf' }),
      );
    const read = createCloudFileReader(fetcher);
    await expect(read('drive', 'secret', '123')).rejects.toMatchObject({
      code: 'INVALID_IMAGE',
    });
    await expect(
      read('drive', 'secret', 'x'.repeat(513)),
    ).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
