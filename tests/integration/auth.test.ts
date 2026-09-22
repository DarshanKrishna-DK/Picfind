import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app';
import { ApiError, type AuthenticationProvider } from '../../apps/api/src/auth';

const origin = 'http://localhost:5173';
const input = { email: 'person@example.test', password: 'test-password-only' };
const user = {
  id: 'test-user',
  name: 'Test Person',
  email: input.email,
  emailVerified: false,
};
function setup(secureCookies = false) {
  const provider = {
    register: vi.fn(async () => user),
    login: vi.fn(async () => ({
      secret: 'test-session-secret',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })),
    getUser: vi.fn(async () => user),
    logout: vi.fn(async () => {}),
  } satisfies AuthenticationProvider;
  return {
    provider,
    app: createApp({ provider, webOrigin: origin, secureCookies }),
  };
}

describe('local authentication contract, with test-only providers and no cloud calls', () => {
  it('sets a host-only secure HttpOnly cookie without returning the session secret', async () => {
    const { app } = setup(true);
    const result = await request(app)
      .post('/api/auth/session')
      .set('Origin', origin)
      .send(input)
      .expect(204);
    expect(result.headers['set-cookie']?.[0]).toContain(
      '__Host-picfind_session=',
    );
    expect(result.headers['set-cookie']?.[0]).toContain('HttpOnly');
    expect(result.headers['set-cookie']?.[0]).toContain('Secure');
    expect(result.headers['set-cookie']?.[0]).toContain('SameSite=Lax');
    expect(result.headers['set-cookie']?.[0]).not.toContain('Domain=');
    expect(result.text).not.toContain('test-session-secret');
  });
  it('registers through the real provider boundary without implicitly creating a session', async () => {
    const { app, provider } = setup();
    const result = await request(app)
      .post('/api/auth/register')
      .set('Origin', origin)
      .send({ ...input, name: user.name })
      .expect(201);
    expect(provider.register).toHaveBeenCalledOnce();
    expect(result.body).toEqual({ user });
    expect(result.headers['set-cookie']).toBeUndefined();
  });
  it.each([undefined, 'https://attacker.example'])(
    'rejects mutation origin %s before authentication',
    async (originHeader) => {
      const { app, provider } = setup();
      const pending = request(app).post('/api/auth/session');
      if (originHeader) pending.set('Origin', originHeader);
      await pending.send(input).expect(403);
      expect(provider.login).not.toHaveBeenCalled();
    },
  );
  it('rejects missing sessions without calling Appwrite', async () => {
    const { app, provider } = setup();
    await request(app).get('/api/auth/session').expect(401);
    expect(provider.getUser).not.toHaveBeenCalled();
  });
  it('validates each session on the server and prevents caching', async () => {
    const { app, provider } = setup();
    const result = await request(app)
      .get('/api/auth/session')
      .set('Cookie', 'picfind_session=test-session-secret')
      .expect(200);
    expect(provider.getUser).toHaveBeenCalledWith('test-session-secret');
    expect(result.body).toEqual({ user });
    expect(result.headers['cache-control']).toBe('no-store');
  });
  it('clears expired cookies when the provider rejects a session', async () => {
    const { app, provider } = setup();
    provider.getUser.mockRejectedValueOnce(
      new ApiError(401, 'UNAUTHENTICATED', 'Please sign in.'),
    );
    const result = await request(app)
      .get('/api/auth/session')
      .set('Cookie', 'picfind_session=expired')
      .expect(401);
    expect(result.headers['set-cookie']?.[0]).toContain(
      'Expires=Thu, 01 Jan 1970',
    );
  });
  it('revokes the provider session before clearing the cookie', async () => {
    const { app, provider } = setup();
    await request(app)
      .delete('/api/auth/session')
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=secret')
      .expect(204);
    expect(provider.logout).toHaveBeenCalledWith('secret');
  });
  it('does not claim logout succeeded when the provider is unavailable', async () => {
    const { app, provider } = setup();
    provider.logout.mockRejectedValueOnce(
      new ApiError(503, 'AUTH_UNAVAILABLE', 'Please try again.'),
    );
    const result = await request(app)
      .delete('/api/auth/session')
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=secret')
      .expect(503);
    // Provider revocation failed, but this browser must still lose access.
    expect(result.headers['set-cookie']).toEqual(
      expect.arrayContaining([expect.stringContaining('picfind_session=;')]),
    );
  });
  it.each(['picfind_session=%zz', 'picfind_session=a; picfind_session=b'])(
    'rejects malformed or ambiguous cookies',
    async (cookie) => {
      const { app, provider } = setup();
      await request(app)
        .get('/api/auth/session')
        .set('Cookie', cookie)
        .expect(400);
      expect(provider.getUser).not.toHaveBeenCalled();
    },
  );
  it('sanitizes unexpected failures and attaches request identifiers', async () => {
    const { app, provider } = setup();
    provider.login.mockRejectedValueOnce(
      new Error('sensitive-provider-response'),
    );
    const result = await request(app)
      .post('/api/auth/session')
      .set('Origin', origin)
      .send(input)
      .expect(500);
    expect(JSON.stringify(result.body)).not.toContain(
      'sensitive-provider-response',
    );
    expect(result.body.error.requestId).toBe(result.headers['x-request-id']);
  });
  it('returns an intentional unavailable state when credentials are absent', async () => {
    const result = await request(createApp())
      .post('/api/auth/session')
      .set('Origin', origin)
      .send(input)
      .expect(503);
    expect(result.body.error.code).toBe('AUTH_UNAVAILABLE');
  });
  it('rejects invalid and oversized input before the provider', async () => {
    const { app, provider } = setup();
    await request(app)
      .post('/api/auth/session')
      .set('Origin', origin)
      .send({ ...input, admin: true })
      .expect(400);
    await request(app)
      .post('/api/auth/session')
      .set('Origin', origin)
      .send({ password: 'x'.repeat(9000) })
      .expect(413);
    expect(provider.login).not.toHaveBeenCalled();
  });
  it('bounds repeated login attempts', async () => {
    const { app, provider } = setup();
    for (let attempt = 0; attempt < 10; attempt++) {
      await request(app)
        .post('/api/auth/session')
        .set('Origin', origin)
        .send(input)
        .expect(204);
    }
    const result = await request(app)
      .post('/api/auth/session')
      .set('Origin', origin)
      .send(input)
      .expect(429);
    expect(result.headers['retry-after']).toBeDefined();
    expect(provider.login).toHaveBeenCalledTimes(10);
  });
});
