import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { DriveFolderBrowser } from '../../apps/api/src/drive-browser.js';
import { createCloudImportRouter } from '../../apps/api/src/cloud-import-router.js';
import { ApiError } from '../../apps/api/src/auth.js';
import { JobQueue } from '../../apps/api/src/jobs.js';
import { TestJobStore } from '../helpers/job-store.js';
import type { SourceConnections } from '../../apps/api/src/source-connections.js';

const file = {
  id: 'photo-1',
  name: 'photo.jpg',
  size: '1024',
  mimeType: 'image/jpeg',
};
function fixture() {
  const state = { generation: randomUUID(), now: 1000 };
  const access = vi.fn(async () => ({
    accessToken: 'synthetic-secret',
    generation: state.generation,
    expiresAt: 3600000,
  }));
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ files: [file], nextPageToken: 'provider-cursor' }),
  );
  const browser = new DriveFolderBrowser({ access }, fetcher, () => state.now);
  return { state, access, fetcher, browser };
}
describe('paginated Drive browsing with synthetic metadata only', () => {
  it('lists one page and binds its encrypted continuation to the normalized folder', async () => {
    const f = fixture();
    const first = await f.browser.list('owner', {
      folder: 'https://drive.google.com/drive/folders/folder-1?usp=sharing',
    });
    expect(first.items).toEqual([
      { id: file.id, name: file.name, bytes: 1024, folder: false },
    ]);
    expect(JSON.stringify(first)).not.toContain('synthetic-secret');
    expect(first.cursor).not.toContain('provider-cursor');
    const url = new URL(String(f.fetcher.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe(
      'https://www.googleapis.com/drive/v3/files',
    );
    expect(url.searchParams.get('q')).toContain(
      "'folder-1' in parents and trashed = false",
    );
    expect(url.searchParams.get('pageSize')).toBe('100');
    expect(url.searchParams.get('supportsAllDrives')).toBe('true');
    expect(f.fetcher.mock.calls[0]![1]?.redirect).toBe('error');
    f.fetcher.mockResolvedValueOnce(Response.json({ files: [] }));
    const next = await f.browser.list('owner', {
      folder: 'folder-1',
      cursor: first.cursor,
    });
    expect(
      new URL(String(f.fetcher.mock.calls[1]![0])).searchParams.get(
        'pageToken',
      ),
    ).toBe('provider-cursor');
    expect(next.cursor).toBeNull();
    expect(f.access).toHaveBeenCalledWith('owner', 'drive');
  });
  it('preserves an empty page continuation and reports incomplete searches', async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(
      Response.json({
        files: [],
        nextPageToken: 'empty-page-next',
        incompleteSearch: true,
      }),
    );
    const page = await f.browser.list('owner', {});
    expect(page.items).toEqual([]);
    expect(page.cursor).toBeTruthy();
    expect(page.incomplete).toBe(true);
  });
  it.each(['owner', 'folder', 'connection', 'expiry', 'restart', 'tampering'])(
    'rejects a continuation after %s changes before calling Google',
    async (change) => {
      const f = fixture();
      const page = await f.browser.list('owner', { folder: 'folder-1' });
      if (change === 'connection') f.state.generation = randomUUID();
      if (change === 'expiry') f.state.now += 31 * 60_000;
      const browser =
        change === 'restart'
          ? new DriveFolderBrowser({ access: f.access }, f.fetcher)
          : f.browser;
      await expect(
        browser.list(change === 'owner' ? 'another-owner' : 'owner', {
          folder: change === 'folder' ? 'folder-2' : 'folder-1',
          cursor: change === 'tampering' ? 'not-a-cursor' : page.cursor,
        }),
      ).rejects.toMatchObject({ code: 'DRIVE_CURSOR_INVALID' });
      expect(f.fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    "folder' or trashed=true",
    'https://attacker.test/drive/folders/id',
    'https://',
    'http://drive.google.com/drive/folders/id',
  ])(
    'rejects an invalid folder %s without requesting tokens or files',
    async (folder) => {
      const f = fixture();
      await expect(f.browser.list('owner', { folder })).rejects.toMatchObject({
        status: 400,
      });
      expect(f.access).not.toHaveBeenCalled();
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );
  it.each([
    [401, 'SOURCE_RECONNECT_REQUIRED'],
    [403, 'SOURCE_ACCESS_DENIED'],
    [404, 'SOURCE_ACCESS_DENIED'],
    [429, 'SOURCE_UNAVAILABLE'],
    [500, 'SOURCE_UNAVAILABLE'],
  ] as const)(
    'handles Google HTTP %i without exposing its response',
    async (status, code) => {
      const f = fixture();
      f.fetcher.mockResolvedValueOnce(
        new Response('private upstream detail', { status }),
      );
      await expect(f.browser.list('owner', {})).rejects.toMatchObject({ code });
    },
  );
  it('asks users to re-browse when Google rejects a continuation', async () => {
    const f = fixture();
    const page = await f.browser.list('owner', {});
    f.fetcher.mockResolvedValueOnce(new Response(null, { status: 400 }));
    await expect(
      f.browser.list('owner', { cursor: page.cursor }),
    ).rejects.toMatchObject({ code: 'DRIVE_CURSOR_INVALID' });
  });
  it('rejects malformed results and non-advancing provider pages', async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(Response.json({ files: [{}] }));
    await expect(f.browser.list('owner', {})).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
    });
    const page = await f.browser.list('owner', {});
    await expect(
      f.browser.list('owner', { cursor: page.cursor }),
    ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  });
  it('lists folders but never imports unsupported files or returns their metadata', async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(
      Response.json({
        files: [
          file,
          {
            id: 'child',
            name: 'Subfolder',
            mimeType: 'application/vnd.google-apps.folder',
          },
          { id: 'doc', name: 'private.pdf', mimeType: 'application/pdf' },
        ],
      }),
    );
    const page = await f.browser.list('owner', {});
    expect(page.items).toHaveLength(2);
    expect(page.items[1]).toMatchObject({ folder: true, name: 'Subfolder' });
    expect(JSON.stringify(page)).not.toContain('private.pdf');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('requires the authenticated import route before accessing the provider', async () => {
    const f = fixture();
    const app = express();
    app.use(
      '/api/imports/queued',
      createCloudImportRouter({
        enabled: true,
        queue: new JobQueue(new TestJobStore()),
        connections: { access: f.access } as unknown as SourceConnections,
        store: () => {
          throw new Error('Browsing must not write to the library');
        },
        owner: async () => {
          throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in');
        },
      }),
    );
    app.use(((error: ApiError, _req, res, _next) => {
      void _next;
      res.status(error.status).json({ code: error.code });
    }) as express.ErrorRequestHandler);
    await request(app).get('/api/imports/queued/drive/items').expect(401);
    expect(f.access).not.toHaveBeenCalled();
  });
});
