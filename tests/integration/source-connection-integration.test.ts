import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { TablesDB } from 'node-appwrite';
import { ApiError } from '../../apps/api/src/auth.js';
import {
  createCloudSources,
  sealSource,
} from '../../apps/api/src/cloud-sources.js';
import {
  AppwriteSourceConnectionStore,
  decodeSourceConnection,
} from '../../apps/api/src/adapters/appwrite-source-connections.js';
import {
  SourceConnections,
  sourceConnectionId,
  type SourceConnectionRecord,
  type SourceConnectionStore,
} from '../../apps/api/src/source-connections.js';
import {
  sourceRefresher,
  sourceConnectionsFromEnvironment,
} from '../../apps/api/src/source-connection-runtime.js';

const key = 'ab'.repeat(32),
  origin = 'http://localhost:5173';
class Store implements SourceConnectionStore {
  rows = new Map<string, SourceConnectionRecord>();
  async get(id: string) {
    return structuredClone(this.rows.get(id));
  }
  async remove(id: string) {
    this.rows.delete(id);
  }
  async mutate<T>(
    id: string,
    operation: (row: SourceConnectionRecord | undefined) => {
      record?: SourceConnectionRecord;
      result: T;
    },
  ) {
    const result = operation(await this.get(id));
    if (result.record) this.rows.set(id, structuredClone(result.record));
    return result.result;
  }
}
function setup() {
  const store = new Store(),
    refresh = vi.fn(async () => ({
      accessToken: 'renewed',
      refreshToken: 'rotated',
      accessExpiresAt: Date.now() + 3600000,
    }));
  const connections = new SourceConnections(store, key, refresh);
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ entries: [], has_more: false }),
  );
  let alive = true;
  const app = express().use(express.json());
  app.use(
    createCloudSources(
      { webOrigin: origin, secureCookies: false },
      {
        connections,
        key,
        providers: {
          dropbox: { clientId: 'drop-id', clientSecret: 'drop-secret' },
          onedrive: { clientId: 'one-id', clientSecret: 'one-secret' },
          box: { clientId: 'box-id', clientSecret: 'box-secret' },
        },
        fetcher,
      },
      async () => {
        if (!alive)
          throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
        return 'owner';
      },
      async () => ({}),
    ),
  );
  app.use(((
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    void _next;
    const failure = error as ApiError;
    res.status(failure.status ?? 500).json({ code: failure.code });
  }) as express.ErrorRequestHandler);
  return {
    store,
    connections,
    refresh,
    fetcher,
    app,
    deleteAccount: () => {
      alive = false;
    },
  };
}
afterEach(() => vi.restoreAllMocks());
describe('cloud routes with persistent grants and synthetic providers', () => {
  it('requests offline Dropbox access and Microsoft refresh scope', async () => {
    const f = setup();
    const drop = await request(f.app)
      .post('/sources/dropbox/connect')
      .expect(200);
    expect(new URL(drop.body.url).searchParams.get('token_access_type')).toBe(
      'offline',
    );
    const one = await request(f.app)
      .post('/sources/onedrive/connect')
      .expect(200);
    expect(new URL(one.body.url).searchParams.get('scope')).toContain(
      'offline_access',
    );
  });
  it('stores a callback grant privately and browses without an access cookie', async () => {
    const f = setup();
    const started = await request(f.app)
      .post('/sources/dropbox/connect')
      .expect(200);
    const state = new URL(started.body.url).searchParams.get('state');
    const cookie = (
      started.headers['set-cookie'] as unknown as string[]
    )[0]!.split(';')[0]!;
    f.fetcher.mockResolvedValueOnce(
      Response.json({
        access_token: 'callback-private',
        refresh_token: 'callback-refresh-private',
        expires_in: 3600,
      }),
    );
    const callback = await request(f.app)
      .get('/sources/dropbox/callback')
      .query({ state, code: 'synthetic-code' })
      .set('Cookie', cookie)
      .expect(302);
    expect(callback.headers.location).toContain('connected=1');
    expect(JSON.stringify([...f.store.rows.values()])).not.toContain(
      'callback-private',
    );
    expect(JSON.stringify(callback.headers)).not.toContain('callback-private');
    const status = await request(f.app).get('/sources').expect(200);
    expect(status.body.sources[0]).toMatchObject({
      connected: true,
      persistent: true,
      backgroundAccess: true,
    });
    expect(JSON.stringify(status.body)).not.toContain('callback-refresh');
    await request(f.app).get('/sources/dropbox/items').expect(200);
    expect(f.fetcher).toHaveBeenLastCalledWith(
      expect.stringContaining('list_folder'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer callback-private',
        }),
      }),
    );
  });
  it('disconnect cannot fall back to a legacy access cookie', async () => {
    const f = setup();
    await f.connections.connect('owner', 'dropbox', {
      accessToken: 'server-token',
      refreshToken: 'refresh',
      accessExpiresAt: Date.now() + 3600000,
    });
    const old = sealSource(
      {
        owner: 'owner',
        provider: 'dropbox',
        value: 'cookie-token',
        expires: Date.now() + 3600000,
      },
      key,
    );
    await request(f.app).delete('/sources/dropbox').expect(204);
    const denied = await request(f.app)
      .get('/sources/dropbox/items')
      .set('Cookie', 'picfind_dropbox=' + old)
      .expect(401);
    expect(denied.body.code).toBe('SOURCE_RECONNECT_REQUIRED');
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('does not store late OAuth credentials after the account was deleted', async () => {
    const f = setup();
    const started = await request(f.app)
      .post('/sources/dropbox/connect')
      .expect(200);
    const state = new URL(started.body.url).searchParams.get('state');
    const cookie = (
      started.headers['set-cookie'] as unknown as string[]
    )[0]!.split(';')[0]!;
    f.fetcher.mockImplementationOnce(async () => {
      f.deleteAccount();
      await f.connections.disconnectOwner('owner');
      await f.connections.removeOwner('owner');
      return Response.json({
        access_token: 'late',
        refresh_token: 'late-refresh',
        expires_in: 3600,
      });
    });
    const result = await request(f.app)
      .get('/sources/dropbox/callback')
      .query({ state, code: 'synthetic' })
      .set('Cookie', cookie)
      .expect(302);
    expect(result.headers.location).toContain('connected=0');
    expect([...f.store.rows.values()].some((row) => row.encryptedGrant)).toBe(
      false,
    );
    expect((await f.connections.status('owner', 'dropbox')).connected).toBe(
      false,
    );
  });
  it('requires an actual reusable grant instead of silently claiming persistence', async () => {
    const f = setup();
    const started = await request(f.app)
      .post('/sources/box/connect')
      .expect(200);
    const state = new URL(started.body.url).searchParams.get('state');
    const cookie = (
      started.headers['set-cookie'] as unknown as string[]
    )[0]!.split(';')[0]!;
    f.fetcher.mockResolvedValueOnce(
      Response.json({ access_token: 'short-lived', expires_in: 3600 }),
    );
    const result = await request(f.app)
      .get('/sources/box/callback')
      .query({ state, code: 'synthetic' })
      .set('Cookie', cookie)
      .expect(302);
    expect(result.headers.location).toContain('connected=0');
    expect([...f.store.rows.values()].some((row) => row.encryptedGrant)).toBe(
      false,
    );
    expect((await f.connections.status('owner', 'box')).connected).toBe(false);
  });
});
describe('fixed endpoint source refresh requests', () => {
  it.each(['drive', 'dropbox', 'onedrive', 'box'] as const)(
    'refreshes %s without redirects or retries',
    async (provider) => {
      const prefix =
        provider === 'drive' ? 'GOOGLE_DRIVE' : provider.toUpperCase();
      const fetcher = vi.fn<typeof fetch>(async () =>
        Response.json({
          access_token: 'access',
          refresh_token: 'rotated',
          expires_in: 3600,
        }),
      );
      const refresh = sourceRefresher(
        {
          [prefix + '_CLIENT_ID']: 'id',
          [prefix + '_CLIENT_SECRET']: 'secret',
        },
        fetcher,
        () => 1000,
      );
      expect(await refresh(provider, 'original')).toMatchObject({
        accessToken: 'access',
        refreshToken: 'rotated',
        accessExpiresAt: 3601000,
      });
      const options = fetcher.mock.calls[0]![1]!;
      expect(options.redirect).toBe('error');
      expect(options.body).toBeInstanceOf(URLSearchParams);
      const form = options.body as URLSearchParams;
      expect(form.get('refresh_token')).toBe('original');
      if (provider === 'onedrive')
        expect(form.get('scope')).toContain('offline_access');
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('does not retry a lost single-use refresh response', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error('Synthetic lost response');
    });
    await expect(
      sourceRefresher(
        { BOX_CLIENT_ID: 'id', BOX_CLIENT_SECRET: 'secret' },
        fetcher,
      )('box', 'single-use'),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('fails malformed token responses and missing persistent configuration closed', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ access_token: 'access', expires_in: -10 }),
    );
    await expect(
      sourceRefresher(
        { BOX_CLIENT_ID: 'id', BOX_CLIENT_SECRET: 'secret' },
        fetcher,
      )('box', 'single-use'),
    ).rejects.toMatchObject({ code: 'SOURCE_RECONNECT_REQUIRED' });
    expect(() =>
      sourceConnectionsFromEnvironment({ SOURCE_CONNECTIONS_ENABLED: 'true' }),
    ).toThrow();
    expect(sourceConnectionsFromEnvironment({})).toBeUndefined();
  });
});
function record(): SourceConnectionRecord {
  return {
    id: sourceConnectionId('owner', 'box'),
    ownerId: 'owner',
    provider: 'box',
    generation: randomUUID(),
    state: 'disconnected',
    updatedAt: new Date().toISOString(),
  };
}
describe('private Appwrite connection storage contract', () => {
  it('rejects row identity, provider and ciphertext-state corruption', () => {
    const value = record(),
      row = {
        $id: value.id,
        ownerId: value.ownerId,
        provider: value.provider,
        payload: JSON.stringify(value),
      };
    expect(decodeSourceConnection(row)).toEqual(value);
    for (const corrupted of [
      { ...row, ownerId: 'other' },
      { ...row, provider: 'drive' },
      {
        ...row,
        payload: JSON.stringify({
          ...value,
          encryptedGrant: 'not-allowed-on-disconnect',
        }),
      },
      { ...row, payload: JSON.stringify({ ...value, state: 'refreshing' }) },
    ])
      expect(() => decodeSourceConnection(corrupted)).toThrow();
  });
  it('creates with no client permissions and retries transactional conflicts only', async () => {
    const value = record(),
      missing = Object.assign(new Error('missing'), { code: 404 }),
      conflict = Object.assign(new Error('conflict'), { code: 409 });
    const db = {
      createTransaction: vi.fn(async () => ({ $id: randomUUID() })),
      getRow: vi.fn(async () => {
        throw missing;
      }),
      createRow: vi.fn(async () => ({})),
      updateTransaction: vi.fn(async (args: { commit?: boolean }) => {
        if (
          args.commit &&
          db.updateTransaction.mock.calls.filter(([arg]) => arg.commit)
            .length === 1
        )
          throw conflict;
        return {};
      }),
    };
    const store = new AppwriteSourceConnectionStore(
      {
        endpoint: 'https://example.test/v1',
        projectId: 'project',
        apiKey: 'synthetic',
      },
      db as unknown as TablesDB,
    );
    expect(
      await store.mutate(value.id, () => ({ record: value, result: 'saved' })),
    ).toBe('saved');
    expect(db.createRow).toHaveBeenCalledTimes(2);
    expect(db.createRow).toHaveBeenLastCalledWith(
      expect.objectContaining({
        permissions: [],
        transactionId: expect.any(String),
        tableId: 'source-connections',
      }),
    );
    expect(db.updateTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ rollback: true }),
    );
  });
  it('propagates storage outages without unsafe create or retry', async () => {
    const db = {
      createTransaction: vi.fn(async () => ({ $id: 'transaction' })),
      getRow: vi.fn(async () => {
        throw Object.assign(new Error('outage'), { code: 503 });
      }),
      createRow: vi.fn(),
      updateTransaction: vi.fn(async () => ({})),
    };
    const store = new AppwriteSourceConnectionStore(
      {
        endpoint: 'https://example.test/v1',
        projectId: 'project',
        apiKey: 'synthetic',
      },
      db as unknown as TablesDB,
    );
    await expect(
      store.mutate(record().id, () => ({
        record: record(),
        result: undefined,
      })),
    ).rejects.toThrow('outage');
    expect(db.createRow).not.toHaveBeenCalled();
    expect(db.createTransaction).toHaveBeenCalledTimes(1);
  });
});
