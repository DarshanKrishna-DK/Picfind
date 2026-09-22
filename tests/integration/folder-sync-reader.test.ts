import { describe, expect, it, vi } from 'vitest';
import { createFolderSyncReader } from '../../apps/api/src/folder-sync-reader.js';
import type { FolderSync } from '../../apps/api/src/folder-sync.js';
import type { SourceConnections } from '../../apps/api/src/source-connections.js';

const key = 'ab'.repeat(32);
const photo = {
  id: 'photo-one',
  name: 'event.jpg',
  size: 100,
  mimeType: 'image/jpeg',
};
function fixture(provider: FolderSync['provider'] = 'drive') {
  const sync: FolderSync = {
    id: 'sync-one',
    ownerId: 'owner',
    actorId: 'moderator',
    eventId: 'event-one',
    membershipGrantId: 'grant-one',
    provider,
    generation: 'generation-one',
    folderId:
      provider === 'box'
        ? '123'
        : provider === 'dropbox'
          ? '/event'
          : 'folder-one',
    status: 'active',
    createdAt: '2026-09-21T00:00:00Z',
    nextRunAt: '2026-09-21T00:00:00Z',
    cursor: null,
    pages: 0,
    imported: 0,
  };
  const access = vi.fn<SourceConnections['access']>();
  // Only the token is consumed by the metadata reader; never a real credential.
  access.mockResolvedValue({ accessToken: 'synthetic-token' } as Awaited<
    ReturnType<SourceConnections['access']>
  >);
  const fetcher = vi.fn<typeof fetch>();
  const guard = vi.fn(async () => {});
  let now = Date.parse(sync.createdAt);
  const reader = () =>
    createFolderSyncReader({ access }, key, fetcher, () => now);
  return {
    sync,
    access,
    fetcher,
    guard,
    reader,
    advance: () => {
      now += 8 * 86400000;
    },
  };
}
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('private folder sync metadata readers', () => {
  it.each(['drive', 'dropbox', 'box', 'onedrive'] as const)(
    'lists only the selected %s folder using the source actor',
    async (provider) => {
      const f = fixture(provider);
      const data =
        provider === 'drive'
          ? { files: [photo] }
          : provider === 'dropbox'
            ? {
                entries: [{ ...photo, '.tag': 'file' }],
                cursor: 'end',
                has_more: false,
              }
            : provider === 'box'
              ? { entries: [{ ...photo, type: 'file' }] }
              : { value: [{ ...photo, file: { mimeType: 'image/jpeg' } }] };
      f.fetcher.mockResolvedValueOnce(response(data));
      await expect(f.reader()(f.sync, 50, f.guard)).resolves.toEqual({
        fileIds: ['photo-one'],
        nextCursor: null,
      });
      expect(f.access).toHaveBeenCalledTimes(2);
      expect(f.access).toHaveBeenCalledWith(
        'moderator',
        provider,
        'generation-one',
      );
      const [input, init] = f.fetcher.mock.calls[0]!;
      const url = new URL(String(input));
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer synthetic-token',
      });
      if (provider === 'drive') {
        expect(url.hostname).toBe('www.googleapis.com');
        expect(url.searchParams.get('q')).toContain("'folder-one' in parents");
        expect(url.searchParams.get('pageSize')).toBe('50');
      } else if (provider === 'dropbox') {
        expect(url.href).toBe('https://api.dropboxapi.com/2/files/list_folder');
        expect(JSON.parse(String(init?.body))).toMatchObject({
          path: '/event',
          recursive: false,
          limit: 50,
        });
      } else if (provider === 'box') {
        expect(url.pathname).toBe('/2.0/folders/123/items');
        expect(url.searchParams.get('usemarker')).toBe('true');
      } else {
        expect(url.pathname).toBe('/v1.0/me/drive/items/folder-one/children');
        expect(url.searchParams.get('$top')).toBe('50');
      }
    },
  );

  it('resumes an encrypted cursor after reader restart without exposing the provider token', async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(
      response({ files: [photo], nextPageToken: 'private-provider-token' }),
    );
    const page = await f.reader()(f.sync, 50, f.guard);
    expect(page.nextCursor).not.toContain('private-provider-token');
    f.fetcher.mockResolvedValueOnce(response({ files: [] }));
    await f.reader()({ ...f.sync, cursor: page.nextCursor }, 50, f.guard);
    expect(
      new URL(String(f.fetcher.mock.calls[1]![0])).searchParams.get(
        'pageToken',
      ),
    ).toBe('private-provider-token');
  });

  it.each([
    'id',
    'ownerId',
    'actorId',
    'eventId',
    'generation',
    'membershipGrantId',
    'folderId',
  ] as const)(
    'rejects cursor replay after %s changes before fetching',
    async (field) => {
      const f = fixture();
      f.fetcher.mockResolvedValueOnce(
        response({ files: [], nextPageToken: 'next' }),
      );
      const page = await f.reader()(f.sync, 50, f.guard);
      await expect(
        f.reader()(
          { ...f.sync, cursor: page.nextCursor, [field]: 'different' },
          50,
          f.guard,
        ),
      ).rejects.toMatchObject({ code: 'SYNC_INVALID_PAGE' });
      expect(f.fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    'https://attacker.example/v1.0/me/drive/items/folder-one/children',
    'https://graph.microsoft.com/v1.0/me/drive/items/another-folder/children',
    'https://user@graph.microsoft.com/v1.0/me/drive/items/folder-one/children',
    'https://graph.microsoft.com:444/v1.0/me/drive/items/folder-one/children',
    'https://graph.microsoft.com/v1.0/me/drive/items/folder-one/children#fragment',
    'https://graph.microsoft.com/v1.0/me/drive/items/folder-one/children?$top=999',
  ])('rejects unsafe Graph continuation %s', async (next) => {
    const f = fixture('onedrive');
    f.fetcher.mockResolvedValueOnce(
      response({ value: [], '@odata.nextLink': next }),
    );
    await expect(f.reader()(f.sync, 50, f.guard)).rejects.toMatchObject({
      code: 'SYNC_INVALID_PAGE',
    });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it('uses Dropbox continuation without switching folder or account', async () => {
    const f = fixture('dropbox');
    f.fetcher.mockResolvedValueOnce(
      response({ entries: [], cursor: 'dropbox-next', has_more: true }),
    );
    const page = await f.reader()(f.sync, 50, f.guard);
    f.fetcher.mockResolvedValueOnce(
      response({ entries: [], cursor: 'dropbox-end', has_more: false }),
    );
    await f.reader()({ ...f.sync, cursor: page.nextCursor }, 50, f.guard);
    const [url, init] = f.fetcher.mock.calls[1]!;
    expect(String(url)).toBe(
      'https://api.dropboxapi.com/2/files/list_folder/continue',
    );
    expect(JSON.parse(String(init?.body))).toEqual({ cursor: 'dropbox-next' });
  });

  it('rejects repeated provider tokens rather than encrypting a loop', async () => {
    const f = fixture();
    f.fetcher.mockImplementation(async () =>
      response({ files: [], nextPageToken: 'same' }),
    );
    const page = await f.reader()(f.sync, 50, f.guard);
    await expect(
      f.reader()({ ...f.sync, cursor: page.nextCursor }, 50, f.guard),
    ).rejects.toMatchObject({ code: 'SYNC_INVALID_PAGE' });
  });

  it('signals an expired private cursor before calling the provider', async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(
      response({ files: [], nextPageToken: 'next' }),
    );
    const page = await f.reader()(f.sync, 50, f.guard);
    f.advance();
    await expect(
      f.reader()({ ...f.sync, cursor: page.nextCursor }, 50, f.guard),
    ).rejects.toMatchObject({ code: 'SYNC_CURSOR_EXPIRED' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it('filters unsupported and oversized photos and deduplicates IDs', async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(
      response({
        files: [
          photo,
          photo,
          { ...photo, id: 'large', size: 100_000_000 },
          { ...photo, id: 'text', mimeType: 'text/plain' },
        ],
      }),
    );
    await expect(f.reader()(f.sync, 50, f.guard)).resolves.toEqual({
      fileIds: ['photo-one'],
      nextCursor: null,
    });
  });

  it.each([
    { files: [photo], incompleteSearch: true },
    {
      files: Array.from({ length: 51 }, (_, i) => ({
        ...photo,
        id: `photo-${i}`,
      })),
    },
    { files: [{ ...photo, size: -1 }] },
    { files: 'invalid' },
  ])('rejects invalid or oversized photo pages', async (data) => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(response(data));
    await expect(f.reader()(f.sync, 50, f.guard)).rejects.toMatchObject({
      code: 'SYNC_INVALID_PAGE',
    });
  });

  it('bounds streamed metadata without trusting content length', async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(new Response('x'.repeat(512 * 1024 + 1)));
    await expect(f.reader()(f.sync, 50, f.guard)).rejects.toMatchObject({
      code: 'SYNC_INVALID_PAGE',
    });
  });

  it.each([
    [401, 'SOURCE_RECONNECT_REQUIRED'],
    [403, 'SOURCE_ACCESS_DENIED'],
    [404, 'SOURCE_ACCESS_DENIED'],
    [429, 'SOURCE_UNAVAILABLE'],
  ] as const)('sanitizes HTTP %s', async (status, code) => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(
      response({ secret: 'must-not-leak' }, status),
    );
    await expect(f.reader()(f.sync, 50, f.guard)).rejects.toMatchObject({
      code,
    });
  });

  it('does not return a page after access is revoked during its request', async () => {
    const f = fixture();
    f.fetcher.mockImplementationOnce(async () => {
      f.guard.mockRejectedValue(new Error('revoked'));
      return response({ files: [photo] });
    });
    await expect(f.reader()(f.sync, 50, f.guard)).rejects.toThrow('revoked');
  });

  it('does not return a page after source generation changes during its request', async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(response({ files: [photo] }));
    f.access
      .mockResolvedValueOnce({ accessToken: 'synthetic' } as Awaited<
        ReturnType<SourceConnections['access']>
      >)
      .mockRejectedValueOnce(new Error('source changed'));
    await expect(f.reader()(f.sync, 50, f.guard)).rejects.toThrow(
      'source changed',
    );
  });
});
