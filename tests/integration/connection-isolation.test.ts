import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import {
  ApiError,
  type AuthenticationProvider,
} from '../../apps/api/src/auth.js';

const origin = 'http://localhost:5173';
const cookies =
  'picfind_session=old-session; picfind_drive_refresh=synthetic-old-token; picfind_source_dropbox=synthetic-old-token; unrelated=keep';
function app(
  overrides: Partial<AuthenticationProvider> = {},
  secureCookies = false,
) {
  const provider: AuthenticationProvider = {
    register: vi.fn(),
    logout: vi.fn(async () => {}),
    login: vi.fn(async () => ({
      secret: 'new-session',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    })),
    getUser: vi.fn(async () => ({
      id: 'new-owner',
      name: 'Synthetic user',
      email: 'new@example.test',
      emailVerified: true,
    })),
    completeGoogle: vi.fn(async () => ({
      secret: 'google-session',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    })),
    ...overrides,
  };
  return createApp({
    provider,
    webOrigin: origin,
    secureCookies,
    googleEnabled: true,
  });
}
function assertConnectionsCleared(headers: string[] | string | undefined) {
  const values = Array.isArray(headers) ? headers : [headers ?? ''];
  expect(values.some((v) => v.startsWith('picfind_drive_refresh=;'))).toBe(
    true,
  );
  expect(values.some((v) => v.startsWith('picfind_source_dropbox=;'))).toBe(
    true,
  );
  expect(values.some((v) => v.startsWith('unrelated='))).toBe(false);
}
describe('connected provider isolation across account sessions', () => {
  it('removes previous-account source cookies when password sign-in succeeds', async () => {
    const res = await request(app())
      .post('/api/auth/session')
      .set('Origin', origin)
      .set('Cookie', cookies)
      .send({ email: 'new@example.test', password: 'Testpassword1!' })
      .expect(204);
    assertConnectionsCleared(res.headers['set-cookie']);
    const setCookies = res.headers['set-cookie'] as unknown as string[];
    expect(
      setCookies.filter((value) => value.startsWith('picfind_session=')).at(-1),
    ).toMatch(/^picfind_session=new-session;/);
  });
  it('removes connected-source cookies on sign-out without clearing another app cookies', async () => {
    const res = await request(app())
      .delete('/api/auth/session')
      .set('Origin', origin)
      .set('Cookie', cookies)
      .expect(204);
    assertConnectionsCleared(res.headers['set-cookie']);
  });
  it('clears expired-session connections even when the provider has already revoked the session', async () => {
    const res = await request(
      app({
        logout: async () => {
          throw new ApiError(401, 'UNAUTHENTICATED', 'Expired');
        },
      }),
    )
      .delete('/api/auth/session')
      .set('Origin', origin)
      .set('Cookie', cookies)
      .expect(204);
    assertConnectionsCleared(res.headers['set-cookie']);
  });
  it('clears stale connections when a session lookup is rejected', async () => {
    const res = await request(
      app({
        getUser: async () => {
          throw new ApiError(401, 'UNAUTHENTICATED', 'Expired');
        },
      }),
    )
      .get('/api/auth/session')
      .set('Cookie', cookies)
      .expect(401);
    assertConnectionsCleared(res.headers['set-cookie']);
  });
  it('does not disconnect the current account on a failed sign-in attempt', async () => {
    const res = await request(
      app({
        login: async () => {
          throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid');
        },
      }),
    )
      .post('/api/auth/session')
      .set('Origin', origin)
      .set('Cookie', cookies)
      .send({ email: 'new@example.test', password: 'Wrongpassword1!' })
      .expect(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
  it('isolates Google sign-in while preserving the allowlisted Studio destination', async () => {
    const res = await request(app())
      .get(
        '/api/account/google/callback?state=valid-state&userId=new-owner&secret=exchange-token',
      )
      .set(
        'Cookie',
        `${cookies}; picfind_oauth=valid-state; picfind_return=%2Fapp%2Fbilling`,
      )
      .expect(302);
    assertConnectionsCleared(res.headers['set-cookie']);
    expect(res.headers.location).toBe(`${origin}/app/billing`);
    const values = res.headers['set-cookie'] as unknown as string[];
    expect(
      values.filter((value) => value.startsWith('picfind_session=')).at(-1),
    ).toMatch(/^picfind_session=google-session;/);
  });
  it('clears secure host-scoped provider cookies with their matching attributes', async () => {
    const res = await request(app({}, true))
      .delete('/api/auth/session')
      .set('Origin', origin)
      .set(
        'Cookie',
        '__Host-picfind_session=old; __Host-picfind_drive_refresh=old; unrelated=keep',
      )
      .expect(204);
    const values = res.headers['set-cookie'] as unknown as string[];
    const cleared = values.find((value) =>
      value.startsWith('__Host-picfind_drive_refresh=;'),
    );
    expect(cleared).toContain('Path=/');
    expect(cleared).toContain('Secure');
    expect(cleared).not.toContain('Domain=');
    expect(values.some((value) => value.startsWith('unrelated='))).toBe(false);
  });
});
