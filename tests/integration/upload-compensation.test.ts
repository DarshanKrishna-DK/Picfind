import { randomUUID } from 'node:crypto';
import request from 'supertest';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import {
  ApiError,
  type AuthenticationProvider,
} from '../../apps/api/src/auth.js';
import type {
  LibraryRecord,
  LibraryStore,
} from '../../apps/api/src/library.js';
import { purgeExpiredPhotos } from '../../apps/api/src/retention.js';

function fixture() {
  const ownerId = randomUUID();
  const rows = new Map<string, LibraryRecord>();
  const files = new Map<string, Uint8Array>();
  const provider: AuthenticationProvider = {
    register: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    getUser: async () => ({
      id: ownerId,
      name: 'Synthetic',
      email: 'synthetic@example.test',
      emailVerified: true,
    }),
  };
  const store: LibraryStore = {
    get: async (id) => {
      const row = rows.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Missing');
      return structuredClone(row);
    },
    list: async (owner, kind) =>
      [...rows.values()]
        .filter((row) => row.ownerId === owner && row.kind === kind)
        .map((row) => structuredClone(row)),
    put: vi.fn(async (row) => {
      rows.set(row.id, structuredClone(row));
    }),
    remove: async (id) => {
      rows.delete(id);
    },
    upload: async (id, bytes) => {
      files.set(id, bytes);
    },
    file: async (id) => {
      const bytes = files.get(id);
      if (!bytes) throw new ApiError(404, 'NOT_FOUND', 'Missing');
      return new Response(Buffer.from(bytes));
    },
    removeFile: vi.fn(async (id) => {
      files.delete(id);
    }),
    expired: async (before) =>
      [...rows.values()].filter(
        (row) => row.expiresAt && row.expiresAt <= before,
      ),
  };
  const app = createApp(
    { provider, webOrigin: 'http://localhost:5173', secureCookies: false },
    { store },
  );
  const upload = async () =>
    request(app)
      .post('/api/photos')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', 'picfind_session=test')
      .set('Content-Type', 'application/octet-stream')
      .set('X-File-Name', 'synthetic.jpg')
      .send(
        await sharp({
          create: { width: 8, height: 8, channels: 3, background: '#abcabc' },
        })
          .jpeg()
          .toBuffer(),
      );
  return { rows, files, store, upload };
}
describe('durable upload compensation without real photo processing', () => {
  it('does not delete an object after an ambiguously successful metadata commit', async () => {
    const { rows, files, store, upload } = fixture();
    vi.mocked(store.put).mockImplementation(async (row) => {
      rows.set(row.id, structuredClone(row));
      if (row.kind === 'photo')
        throw new ApiError(503, 'TIMEOUT', 'Commit reply lost');
    });
    const response = await upload();
    expect(response.status).toBe(201);
    expect(files.size).toBe(1);
    const again = await upload();
    expect(again.status).toBe(201);
    expect(files.size).toBe(1);
    expect(store.removeFile).not.toHaveBeenCalled();
  });
  it('keeps a durable cleanup reference when both final metadata and object cleanup fail', async () => {
    const { rows, files, store, upload } = fixture();
    vi.mocked(store.put).mockImplementation(async (row) => {
      if (row.kind === 'photo')
        throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Write failed');
      rows.set(row.id, structuredClone(row));
    });
    vi.mocked(store.removeFile).mockRejectedValueOnce(
      new ApiError(503, 'STORAGE_UNAVAILABLE', 'Delete failed'),
    );
    const response = await upload();
    expect(response.status).toBe(503);
    expect(files.size).toBe(1);
    expect(rows.size).toBe(1);
    const pending = [...rows.values()][0]!;
    expect(pending.kind).toBe('job');
    expect(pending.purpose).toBe('upload-cleanup');
    rows.set(pending.id, {
      ...pending,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      cleanupAfter: new Date(Date.now() - 1000).toISOString(),
    });
    expect(await purgeExpiredPhotos(store)).toEqual({
      deleted: 1,
      deferred: 0,
    });
    expect(files.size).toBe(0);
    expect(rows.size).toBe(0);
  });
  it('records the cleanup intent before starting the object write', async () => {
    const { rows, store, upload } = fixture();
    store.upload = vi.fn(async (id) => {
      expect(rows.get(id)?.purpose).toBe('upload-cleanup');
    });
    expect((await upload()).status).toBe(201);
  });
});
