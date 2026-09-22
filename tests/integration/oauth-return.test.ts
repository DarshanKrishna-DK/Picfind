import { expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app';
import type { AuthenticationProvider } from '../../apps/api/src/auth';

it.each(['/app/events/new', '//attacker.test', '/app/discover/new'])(
  'Google callbacks only redirect to an allowed saved destination: %s',
  async (returnTo) => {
    const provider = {
      register: vi.fn(),
      login: vi.fn(),
      getUser: vi.fn(),
      logout: vi.fn(),
      beginGoogle: vi.fn(async () => 'https://accounts.google.com/test-only'),
      completeGoogle: vi.fn(async () => ({
        secret: 'test-only-session',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
    } satisfies AuthenticationProvider;
    const origin = 'http://localhost:5173';
    const app = createApp({
      provider,
      webOrigin: origin,
      secureCookies: false,
      googleEnabled: true,
    });
    const started = await request(app)
      .post('/api/account/google')
      .set('Origin', origin)
      .send({ returnTo })
      .expect(200);
    const cookies = (started.headers['set-cookie'] as unknown as string[]).map(
      (value) => value.split(';')[0]!,
    );
    const state = cookies
      .find((value) => value.startsWith('picfind_oauth='))!
      .split('=')[1]!;
    const response = await request(app)
      .get(
        `/api/account/google/callback?state=${state}&userId=test&secret=test-token`,
      )
      .set('Cookie', cookies)
      .expect(302);
    expect(response.headers.location).toBe(
      `${origin}${returnTo.startsWith('//') ? '/app' : returnTo}`,
    );
    expect(cookies.some((value) => value.startsWith('picfind_return='))).toBe(
      true,
    );
    expect(
      (response.headers['set-cookie'] as unknown as string[]).filter((value) =>
        value.includes('Expires=Thu, 01 Jan 1970'),
      ),
    ).toHaveLength(2);
  },
);
