import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app.js';
import {
  sealDriveValue,
  openDriveValue,
} from '../../apps/api/src/drive-connection.js';
import type { AuthenticationProvider } from '../../apps/api/src/auth.js';

const config = {
  clientId: 'synthetic-client',
  clientSecret: 'synthetic-secret-never-used-live',
  webOrigin: 'http://localhost:5173',
  secureCookies: false,
};
afterEach(() => vi.unstubAllGlobals());
describe('account-bound Google Drive connections', () => {
  it('encrypts and authenticates credentials for one account and purpose', () => {
    const sealed = sealDriveValue(
      config,
      'owner-a',
      'private-refresh-token',
      'refresh',
    );
    expect(sealed).not.toContain('private-refresh-token');
    expect(openDriveValue(config, 'owner-a', sealed, 'refresh')).toBe(
      'private-refresh-token',
    );
    expect(() =>
      openDriveValue(config, 'owner-b', sealed, 'refresh'),
    ).toThrow();
    expect(() => openDriveValue(config, 'owner-a', sealed, 'state')).toThrow();
    expect(() =>
      openDriveValue(
        { ...config, clientSecret: 'rotated' },
        'owner-a',
        sealed,
        'refresh',
      ),
    ).toThrow();
    const parts = sealed.split('.');
    parts[2] = Buffer.alloc(16).toString('base64url');
    expect(() =>
      openDriveValue(config, 'owner-a', parts.join('.'), 'refresh'),
    ).toThrow();
    expect(() =>
      openDriveValue(config, 'owner-a', 'legacy-raw-token', 'refresh'),
    ).toThrow();
  });
  it('expires state and refresh grants without accepting future-issued values', () => {
    const now = Date.parse('2026-09-21T00:00:00Z');
    const state = sealDriveValue(config, 'owner-a', 'state', 'state', now);
    expect(() =>
      openDriveValue(config, 'owner-a', state, 'state', now + 600001),
    ).toThrow();
    expect(() =>
      openDriveValue(config, 'owner-a', state, 'state', now - 60001),
    ).toThrow();
  });
  it('cannot reuse a late callback response to connect a different signed-in account', async () => {
    const provider: AuthenticationProvider = {
      register: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      getUser: async (secret) => ({
        id: secret,
        name: 'Synthetic',
        email: 'synthetic@example.test',
        emailVerified: true,
      }),
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fetch = vi.fn(async () => {
      entered();
      await gate;
      return Response.json({
        access_token: 'test-access',
        refresh_token: 'test-refresh',
        expires_in: 3600,
      });
    });
    vi.stubGlobal('fetch', fetch);
    const app = createApp(
      { provider, webOrigin: config.webOrigin, secureCookies: false },
      { driveOAuth: config },
    );
    const start = await request(app)
      .post('/api/drive/connect')
      .set('Origin', config.webOrigin)
      .set('Cookie', 'picfind_session=owner-a')
      .expect(200);
    const state = new URL(start.body.url as string).searchParams.get('state')!;
    const stateCookie = String(start.headers['set-cookie']?.[0]).split(';')[0]!;
    const pending = request(app)
      .get(`/api/drive/callback?state=${state}&code=synthetic-code`)
      .set('Cookie', `picfind_session=owner-a; ${stateCookie}`)
      .then((res) => res);
    await started;
    release();
    const callback = await pending;
    expect(callback.status).toBe(302);
    const cookies = callback.headers['set-cookie'] as unknown as string[];
    const connection = cookies
      .find((value) => value.startsWith('picfind_drive='))!
      .split(';')[0]!;
    const a = await request(app)
      .get('/api/capabilities')
      .set('Cookie', `picfind_session=owner-a; ${connection}`)
      .expect(200);
    const b = await request(app)
      .get('/api/capabilities')
      .set('Cookie', `picfind_session=owner-b; ${connection}`)
      .expect(200);
    expect(a.body.driveConnected).toBe(true);
    expect(b.body.driveConnected).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
