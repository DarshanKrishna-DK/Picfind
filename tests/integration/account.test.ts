import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app';
import { ApiError, type AuthenticationProvider } from '../../apps/api/src/auth';
import type { LibraryRecord, LibraryStore } from '../../apps/api/src/library';

const origin = 'http://localhost:5173';
const cookie = 'picfind_session=session';
describe('sensitive action email confirmation', () => {
  it('limits email sends per authenticated account without blocking another account on the same IP', async () => {
    const { app, provider, user } = setup();
    const send = () =>
      request(app)
        .post('/api/account/confirmation')
        .set('Origin', origin)
        .set('Cookie', cookie);
    for (let attempt = 0; attempt < 5; attempt++) await send().expect(202);
    const rejected = await send().expect(429);
    expect(rejected.body.error.code).toBe('RATE_LIMITED');
    expect(provider.sendActionCode).toHaveBeenCalledTimes(5);
    provider.getUser.mockResolvedValue({ ...user, id: randomUUID() });
    await send().expect(202);
    expect(provider.sendActionCode).toHaveBeenCalledTimes(6);
  });
  it('shares the account proof attempt budget across password and deletion', async () => {
    const { app, provider } = setup();
    provider.verifyActionCode.mockRejectedValue(
      new ApiError(401, 'UNAUTHENTICATED', 'Invalid or expired code.'),
    );
    for (let attempt = 0; attempt < 10; attempt++) {
      const passwordAttempt = attempt % 2 === 0;
      await (
        passwordAttempt
          ? request(app).post('/api/account/password')
          : request(app).delete('/api/account')
      )
        .set('Origin', origin)
        .set('Cookie', cookie)
        .send(
          passwordAttempt
            ? {
                oldPassword: 'old-password',
                password: 'new-password',
                emailCode: '000000',
              }
            : {
                password: 'old-password',
                confirmation: 'DELETE',
                emailCode: '000000',
              },
        )
        .expect(401);
    }
    await request(app)
      .post('/api/account/password')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({
        oldPassword: 'old-password',
        password: 'new-password',
        emailCode: '000000',
      })
      .expect(429);
    expect(provider.verifyActionCode).toHaveBeenCalledTimes(10);
    expect(provider.changePassword).not.toHaveBeenCalled();
    expect(provider.deleteUser).not.toHaveBeenCalled();
  });
  it.each(['changePassword', 'revokeOtherSessions'] as const)(
    'rejects missing %s support before consuming email proof or changing credentials',
    async (missing) => {
      const { auth, provider, store } = setup();
      const limited = { ...provider, [missing]: undefined };
      const app = createApp({ ...auth, provider: limited }, { store });
      await request(app)
        .post('/api/account/password')
        .set('Origin', origin)
        .set('Cookie', cookie)
        .send({
          oldPassword: 'old-password',
          password: 'new-password',
          emailCode: '123456',
        })
        .expect(503);
      expect(provider.verifyActionCode).not.toHaveBeenCalled();
      expect(provider.changePassword).not.toHaveBeenCalled();
      expect(provider.revokeOtherSessions).not.toHaveBeenCalled();
    },
  );
  it.each(['sendActionCode', 'verifyActionCode'] as const)(
    'does not advertise deletion without %s support',
    async (missing) => {
      const { auth, provider, store } = setup();
      const app = createApp(
        { ...auth, provider: { ...provider, [missing]: undefined } },
        { store },
      );
      const response = await request(app)
        .get('/api/account/capabilities')
        .expect(200);
      expect(response.body.deletion).toBe(false);
    },
  );
  it('only sends a code to the authenticated account', async () => {
    const { app, provider, user } = setup();
    await request(app)
      .post('/api/account/confirmation')
      .set('Origin', origin)
      .expect(401);
    expect(provider.sendActionCode).not.toHaveBeenCalled();
    await request(app)
      .post('/api/account/confirmation')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({ email: 'attacker@example.test' })
      .expect(202);
    expect(provider.sendActionCode).toHaveBeenCalledWith(user);
  });
  it.each(['password', 'delete'])(
    'rejects missing or failed email proof for %s before mutations',
    async (kind) => {
      const { app, provider, store } = setup();
      const list = vi.spyOn(store, 'list');
      const body =
        kind === 'password'
          ? { oldPassword: 'old-password', password: 'new-password' }
          : { password: 'test-password', confirmation: 'DELETE' };
      const send = (data: object) =>
        (kind === 'password'
          ? request(app).post('/api/account/password')
          : request(app).delete('/api/account')
        )
          .set('Origin', origin)
          .set('Cookie', cookie)
          .send(data);
      await send(body).expect(400);
      expect(provider.verifyActionCode).not.toHaveBeenCalled();
      provider.verifyActionCode.mockRejectedValueOnce(
        new ApiError(401, 'UNAUTHENTICATED', 'Invalid or expired code.'),
      );
      await send({ ...body, emailCode: '000000' }).expect(401);
      expect(provider.changePassword).not.toHaveBeenCalled();
      expect(provider.deleteUser).not.toHaveBeenCalled();
      expect(provider.login).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
    },
  );
});
function setup(googleEnabled = false) {
  const user = {
    id: randomUUID(),
    name: 'Test Person',
    email: 'person@example.test',
    emailVerified: false,
  };
  const rows = new Map<string, LibraryRecord>();
  const operations: string[] = [];
  const provider = {
    register: vi.fn(async () => user),
    login: vi.fn(async () => ({
      secret: 'temporary',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })),
    getUser: vi.fn(async () => user),
    logout: vi.fn(async () => {}),
    recover: vi.fn(async () => {}),
    resetPassword: vi.fn(async () => {}),
    sendVerification: vi.fn(async () => {}),
    verifyEmail: vi.fn(async () => {}),
    updateName: vi.fn(async (_secret: string, name: string) => ({
      ...user,
      name,
    })),
    changePassword: vi.fn(async () => {}),
    sendActionCode: vi.fn(async () => {}),
    verifyActionCode: vi.fn(async () => {}),
    revokeOtherSessions: vi.fn(async () => {}),
    beginGoogle: vi.fn(async () => 'https://accounts.google.com/test-only'),
    completeGoogle: vi.fn(async () => ({
      secret: 'oauth-session',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })),
    deleteUser: vi.fn(async () => {
      operations.push('delete-user');
    }),
  } satisfies AuthenticationProvider;
  const store: LibraryStore = {
    list: async (ownerId, kind) =>
      [...rows.values()].filter(
        (row) => row.ownerId === ownerId && row.kind === kind,
      ),
    get: async (id) => {
      const row = rows.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
      return row;
    },
    put: async (row) => {
      rows.set(row.id, row);
      operations.push(`put-${row.kind}`);
    },
    remove: async (id) => {
      rows.delete(id);
      operations.push('remove-row');
    },
    upload: async () => {},
    file: async () => new Response(new Uint8Array()),
    removeFile: vi.fn(async () => {
      operations.push('remove-file');
    }),
  };
  const auth = {
    provider,
    webOrigin: origin,
    secureCookies: false,
    googleEnabled,
  };
  return {
    app: createApp(auth, { store }),
    auth,
    provider,
    store,
    rows,
    operations,
    user,
  };
}

describe('account lifecycle with test-only providers and no external calls', () => {
  it('reports unavailable Google sign-in honestly', async () => {
    const { app, provider } = setup();
    const result = await request(app)
      .get('/api/account/capabilities')
      .expect(200);
    expect(result.body).toEqual({
      google: false,
      recovery: true,
      verification: true,
      deletion: true,
    });
    await request(app)
      .post('/api/account/google')
      .set('Origin', origin)
      .expect(503);
    expect(provider.beginGoogle).not.toHaveBeenCalled();
  });
  it.each([undefined, 'https://attacker.example'])(
    'rejects recovery origin %s',
    async (value) => {
      const { app, provider } = setup();
      const pending = request(app).post('/api/account/recovery');
      if (value) pending.set('Origin', value);
      await pending.send({ email: 'person@example.test' }).expect(403);
      expect(provider.recover).not.toHaveBeenCalled();
    },
  );
  it('uses an application-controlled recovery URL and generic acknowledgement', async () => {
    const { app, provider } = setup();
    const response = await request(app)
      .post('/api/account/recovery')
      .set('Origin', origin)
      .send({ email: 'person@example.test' })
      .expect(202);
    expect(provider.recover).toHaveBeenCalledWith(
      'person@example.test',
      `${origin}/reset-password`,
    );
    expect(response.body.message).toContain('If that address has an account');
    await request(app)
      .post('/api/account/recovery')
      .set('Origin', origin)
      .send({ email: 'person@example.test', url: 'https://attacker.example' })
      .expect(400);
  });
  it('validates reset tokens and clears the local session after reset', async () => {
    const { app, provider } = setup();
    await request(app)
      .post('/api/account/reset-password')
      .set('Origin', origin)
      .send({ userId: '', secret: '', password: 'short' })
      .expect(400);
    expect(provider.resetPassword).not.toHaveBeenCalled();
    const data = {
      userId: 'test-user',
      secret: 'test-token',
      password: 'new-password-only',
    };
    const response = await request(app)
      .post('/api/account/reset-password')
      .set('Origin', origin)
      .send(data)
      .expect(204);
    expect(provider.resetPassword).toHaveBeenCalledWith(data);
    expect(response.headers['set-cookie']?.[0]).toContain(
      'Expires=Thu, 01 Jan 1970',
    );
  });
  it('requires a session to request verification and uses a fixed callback', async () => {
    const { app, provider } = setup();
    await request(app)
      .post('/api/account/verification')
      .set('Origin', origin)
      .expect(401);
    await request(app)
      .post('/api/account/verification')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .expect(202);
    expect(provider.sendVerification).toHaveBeenCalledWith(
      'session',
      `${origin}/verify-email`,
    );
    await request(app)
      .post('/api/account/verify-email')
      .set('Origin', origin)
      .send({ userId: 'user', secret: 'token' })
      .expect(204);
    expect(provider.verifyEmail).toHaveBeenCalledWith({
      userId: 'user',
      secret: 'token',
    });
  });
  it('requires authentication and rejects profile role escalation', async () => {
    const { app, provider } = setup();
    await request(app)
      .patch('/api/account/profile')
      .set('Origin', origin)
      .send({ name: 'Updated' })
      .expect(401);
    await request(app)
      .patch('/api/account/profile')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({ name: 'Updated', role: 'admin' })
      .expect(400);
    const result = await request(app)
      .patch('/api/account/profile')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({ name: ' Updated ' })
      .expect(200);
    expect(result.body.user.name).toBe('Updated');
    expect(provider.updateName).toHaveBeenCalledWith('session', 'Updated');
  });
  it('changes a password before revoking other sessions', async () => {
    const { app, provider } = setup();
    await request(app)
      .post('/api/account/password')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({
        emailCode: '123456',
        oldPassword: 'old-password',
        password: 'new-password',
      })
      .expect(204);
    expect(provider.changePassword).toHaveBeenCalledWith(
      'session',
      'old-password',
      'new-password',
    );
    expect(provider.revokeOtherSessions).toHaveBeenCalledWith('session');
    expect(provider.changePassword.mock.invocationCallOrder[0]).toBeLessThan(
      provider.revokeOtherSessions.mock.invocationCallOrder[0]!,
    );
  });
  it('does not revoke sessions after an incorrect current password', async () => {
    const { app, provider } = setup();
    provider.changePassword.mockRejectedValueOnce(
      new ApiError(401, 'UNAUTHENTICATED', 'Incorrect credentials.'),
    );
    await request(app)
      .post('/api/account/password')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({
        emailCode: '123456',
        oldPassword: 'wrong-password',
        password: 'new-password',
      })
      .expect(401);
    expect(provider.revokeOtherSessions).not.toHaveBeenCalled();
  });
  it('supports explicit other-session revocation', async () => {
    const { app, provider } = setup();
    await request(app)
      .delete('/api/account/sessions/others')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .expect(204);
    expect(provider.revokeOtherSessions).toHaveBeenCalledWith('session');
  });
  it('rejects a forged OAuth callback before exchanging credentials', async () => {
    const { app, provider } = setup(true);
    await request(app)
      .get('/api/account/google/callback?state=forged&userId=user&secret=token')
      .expect(302)
      .expect('Location', `${origin}/sign-in?error=google`);
    expect(provider.completeGoogle).not.toHaveBeenCalled();
  });
  it('binds OAuth callbacks to a same-browser state cookie', async () => {
    const { app, provider } = setup(true);
    const start = await request(app)
      .post('/api/account/google')
      .set('Origin', origin)
      .expect(200);
    const stateCookie = String(start.headers['set-cookie']?.[0]).split(';')[0]!;
    const state = stateCookie.slice(stateCookie.indexOf('=') + 1);
    const result = await request(app)
      .get(
        `/api/account/google/callback?state=${state}&userId=user&secret=token`,
      )
      .set('Cookie', stateCookie)
      .expect(302)
      .expect('Location', `${origin}/app`);
    expect(provider.completeGoogle).toHaveBeenCalledWith('user', 'token');
    expect([result.headers['set-cookie']].flat().join(';')).toContain(
      'picfind_session=oauth-session',
    );
    expect(result.headers['referrer-policy']).toBe('no-referrer');
  });
  it('requires typed confirmation and current password before deletion', async () => {
    const { app, provider } = setup();
    await request(app)
      .delete('/api/account')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({
        emailCode: '123456',
        confirmation: 'delete',
        password: 'test-password',
      })
      .expect(400);
    provider.login.mockRejectedValueOnce(
      new ApiError(401, 'UNAUTHENTICATED', 'Incorrect credentials.'),
    );
    await request(app)
      .delete('/api/account')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({
        emailCode: '123456',
        confirmation: 'DELETE',
        password: 'wrong-password',
      })
      .expect(401);
    expect(provider.deleteUser).not.toHaveBeenCalled();
  });
  it('revokes gallery access, purges owner data, then deletes the account', async () => {
    const { app, provider, user, rows, operations } = setup();
    for (const kind of ['event', 'photo', 'job'] as const) {
      const id = randomUUID();
      rows.set(id, {
        id,
        kind,
        ownerId: user.id,
        createdAt: new Date().toISOString(),
        visibility: 'link',
      });
    }
    const otherId = randomUUID();
    rows.set(otherId, {
      id: otherId,
      kind: 'photo',
      ownerId: 'another-owner',
      createdAt: new Date().toISOString(),
    });
    await request(app)
      .delete('/api/account')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({
        emailCode: '123456',
        confirmation: 'DELETE',
        password: 'test-password',
      })
      .expect(204);
    expect(operations[0]).toBe('put-event');
    expect(operations.at(-1)).toBe('delete-user');
    expect(rows.size).toBe(1);
    expect(rows.has(otherId)).toBe(true);
    expect(provider.logout).toHaveBeenCalledWith('temporary');
    expect(provider.deleteUser).toHaveBeenCalledWith(user.id);
    // A request already authenticated before deletion cannot recreate owner data.
    await request(app)
      .post('/api/events')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({ title: 'After deletion' })
      .expect(401);
  });
  it('leaves the account intact on a storage cleanup failure', async () => {
    const { app, provider, user, rows, store } = setup();
    const id = randomUUID();
    rows.set(id, {
      id,
      kind: 'photo',
      ownerId: user.id,
      createdAt: new Date().toISOString(),
    });
    vi.mocked(store.removeFile).mockRejectedValueOnce(
      new ApiError(503, 'STORAGE_UNAVAILABLE', 'Try again.'),
    );
    await request(app)
      .delete('/api/account')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({
        emailCode: '123456',
        confirmation: 'DELETE',
        password: 'test-password',
      })
      .expect(503);
    expect(provider.deleteUser).not.toHaveBeenCalled();
    expect(rows.has(id)).toBe(true);
  });
  it('checks provider deletion support before touching account data', async () => {
    const { auth, store, provider } = setup();
    const { deleteUser: unavailable, ...limited } = provider;
    void unavailable;
    const list = vi.spyOn(store, 'list');
    const app = createApp({ ...auth, provider: limited }, { store });
    await request(app)
      .delete('/api/account')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({
        emailCode: '123456',
        confirmation: 'DELETE',
        password: 'test-password',
      })
      .expect(503);
    expect(list).not.toHaveBeenCalled();
    expect(provider.login).not.toHaveBeenCalled();
  });
});
