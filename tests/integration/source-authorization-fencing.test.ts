import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app.js';
import {
  SourceConnections,
  type SourceConnectionRecord,
  type SourceConnectionStore,
  type SourceProvider,
} from '../../apps/api/src/source-connections.js';

afterEach(() => vi.unstubAllGlobals());
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function fixture(source: SourceProvider) {
  const owner = randomUUID(),
    rows = new Map<string, SourceConnectionRecord>(),
    entered = gate(),
    finish = gate();
  const store: SourceConnectionStore = {
    get: async (id) => structuredClone(rows.get(id)),
    remove: async (id) => {
      rows.delete(id);
    },
    mutate: async (id, operation) => {
      const change = operation(structuredClone(rows.get(id)));
      if (change.record) rows.set(id, change.record);
      return change.result;
    },
  };
  const vault = new SourceConnections(store, 'ab'.repeat(32), async () => ({
    accessToken: 'fresh',
    accessExpiresAt: Date.now() + 3600000,
  }));
  let exchanges = 0;
  const fetcher = vi.fn<typeof fetch>(async () => {
    const attempt = ++exchanges;
    if (attempt === 1) {
      entered.release();
      await finish.promise;
    }
    return Response.json({
      access_token: 'access-' + attempt,
      refresh_token: 'refresh-' + attempt,
      expires_in: 3600,
    });
  });
  vi.stubGlobal('fetch', fetcher);
  const app = createApp(
    {
      webOrigin: 'http://localhost:5173',
      secureCookies: false,
      provider: {
        register: vi.fn(),
        login: vi.fn(),
        logout: vi.fn(),
        getUser: async () => ({
          id: owner,
          name: 'Synthetic',
          email: 'owner@example.test',
          emailVerified: true,
        }),
      },
    },
    {
      sourceConnections: vault,
      driveOAuth: { clientId: 'id', clientSecret: 'secret' },
      sources: {
        key: 'ab'.repeat(32),
        fetcher,
        providers: {
          dropbox: { clientId: 'id', clientSecret: 'secret' },
          onedrive: { clientId: 'id', clientSecret: 'secret' },
          box: { clientId: 'id', clientSecret: 'secret' },
        },
      },
    },
  );
  const base = source === 'drive' ? '/api/drive' : '/api/sources/' + source;
  async function begin() {
    const result = await request(app)
      .post(base + '/connect')
      .set('Cookie', 'picfind_session=synthetic')
      .set('Origin', 'http://localhost:5173')
      .expect(200);
    return {
      state: new URL(result.body.url).searchParams.get('state'),
      cookie: (result.headers['set-cookie'] as unknown as string[])[0]!.split(
        ';',
      )[0]!,
    };
  }
  const callback = (attempt: Awaited<ReturnType<typeof begin>>) =>
    request(app)
      .get(base + '/callback')
      .query({ code: 'synthetic-code', state: attempt.state })
      .set('Cookie', 'picfind_session=synthetic; ' + attempt.cookie)
      .then((response) => response);
  const disconnect = () =>
    request(app)
      .delete(base)
      .set('Cookie', 'picfind_session=synthetic')
      .set('Origin', 'http://localhost:5173')
      .expect(204);
  return {
    owner,
    vault,
    app,
    entered,
    finish,
    begin,
    callback,
    disconnect,
    fetcher,
  };
}
describe('OAuth callback fencing with synthetic provider responses', () => {
  it.each(['drive', 'dropbox', 'onedrive', 'box'] as const)(
    '%s cannot reconnect after disconnect during token exchange',
    async (source) => {
      const f = fixture(source),
        attempt = await f.begin();
      const callback = f.callback(attempt);
      await f.entered.promise;
      await f.disconnect();
      f.finish.release();
      expect((await callback).headers.location).toContain(
        source === 'drive' ? 'drive=error' : 'connected=0',
      );
      expect((await f.vault.status(f.owner, source)).connected).toBe(false);
    },
  );
  it.each(['drive', 'dropbox', 'onedrive', 'box'] as const)(
    '%s cannot overwrite a later successful OAuth attempt',
    async (source) => {
      const f = fixture(source),
        first = await f.begin();
      const old = f.callback(first);
      await f.entered.promise;
      const second = await f.begin(),
        recent = await f.callback(second);
      expect(recent.headers.location).toContain(
        source === 'drive' ? 'drive=connected' : 'connected=1',
      );
      const generation = (await f.vault.access(f.owner, source)).generation;
      f.finish.release();
      expect((await old).headers.location).toContain(
        source === 'drive' ? 'drive=error' : 'connected=0',
      );
      expect((await f.vault.access(f.owner, source)).generation).toBe(
        generation,
      );
    },
  );
  it('persistent Drive does not make anonymous capabilities require sign-in', async () => {
    const f = fixture('drive');
    const response = await request(f.app).get('/api/capabilities').expect(200);
    expect(response.body.driveConnected).toBe(false);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
