import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app.js';
import type { AuthenticationProvider } from '../../apps/api/src/auth.js';
import type { SourceConnections } from '../../apps/api/src/source-connections.js';

const origin = 'http://localhost:5173';
afterEach(() => vi.unstubAllGlobals());
async function start(returnTo: string) {
  const provider: AuthenticationProvider = {
    register: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    getUser: async () => ({
      id: 'owner',
      name: 'Synthetic owner',
      email: 'owner@example.test',
      emailVerified: true,
    }),
  };
  const connect = vi.fn(async () => ({ generation: 'new-generation' }));
  const connections = {
    beginAuthorization: vi.fn(async () => 'saved-attempt'),
    connect,
  } as unknown as SourceConnections;
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      access_token: 'synthetic-access',
      refresh_token: 'synthetic-refresh',
      expires_in: 3600,
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  const app = createApp(
    { provider, webOrigin: origin, secureCookies: false },
    {
      sourceConnections: connections,
      driveOAuth: {
        clientId: 'synthetic-client',
        clientSecret: 'synthetic-secret',
      },
    },
  );
  const response = await request(app)
    .post('/api/drive/connect')
    .set('Origin', origin)
    .set('Cookie', 'picfind_session=synthetic-session')
    .send({ returnTo })
    .expect(200);
  const cookies = (response.headers['set-cookie'] as unknown as string[]).map(
    (value) => value.split(';')[0]!,
  );
  cookies.push('picfind_session=synthetic-session');
  return {
    app,
    cookies,
    state: new URL(response.body.url).searchParams.get('state')!,
    connect,
    fetcher,
  };
}
describe('Drive import OAuth return with synthetic Google exchange', () => {
  it.each([
    ['/app/import', '/app/import?source=drive&drive=connected'],
    ['/app/discover/new', '/app/discover/new?drive=connected'],
    ['https://attacker.test', '/app/discover/new?drive=connected'],
    ['//attacker.test', '/app/discover/new?drive=connected'],
  ])(
    'uses the signed allowlisted destination for %s',
    async (returnTo, expected) => {
      const f = await start(returnTo!);
      const response = await request(f.app)
        .get('/api/drive/callback')
        .query({
          state: f.state,
          code: 'synthetic-code',
          returnTo: 'https://attacker.test',
        })
        .set('Cookie', f.cookies)
        .expect(302);
      expect(response.headers.location).toBe(origin + expected);
      expect(f.connect).toHaveBeenCalledWith(
        'owner',
        'drive',
        { refreshToken: 'synthetic-refresh', accessExpiresAt: 0 },
        'saved-attempt',
      );
      expect(f.fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('returns cancellation to imports without exchanging a token', async () => {
    const f = await start('/app/import');
    const response = await request(f.app)
      .get('/api/drive/callback')
      .query({ state: f.state, error: 'access_denied' })
      .set('Cookie', f.cookies)
      .expect(302);
    expect(response.headers.location).toBe(
      origin + '/app/import?source=drive&drive=error',
    );
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('does not trust return context until state verification passes', async () => {
    const f = await start('/app/import');
    const response = await request(f.app)
      .get('/api/drive/callback')
      .query({ state: 'wrong-state', code: 'synthetic-code' })
      .set('Cookie', f.cookies)
      .expect(302);
    expect(response.headers.location).toBe(
      origin + '/app/discover/new?drive=error',
    );
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
