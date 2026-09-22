import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(
  new URL('../../scripts/dev-startup.mjs', import.meta.url),
  'utf8',
).replace('export async function', 'async function');
const waitForStartup = runInNewContext(`${source}\nwaitForStartup`, {
  AbortSignal,
  setTimeout,
}) as (options: {
  fetch: typeof fetch;
  pause: () => Promise<void>;
  attempts: number;
  isStopping?: () => boolean;
}) => Promise<boolean>;

function fixture(health: unknown = { service: 'PicFind', status: 'alive' }) {
  const fetch = vi.fn(async (url: string | URL | Request) =>
    String(url).endsWith('/health')
      ? Response.json(health)
      : new Response('<html>PicFind</html>'),
  );
  const pause = vi.fn(async () => undefined);
  return { fetch, pause, attempts: 3 };
}

describe('one-click launcher startup, synthetic local HTTP only', () => {
  it('requires the web page and the proxied PicFind API', async () => {
    const f = fixture();
    await expect(waitForStartup(f)).resolves.toBe(true);
    expect(f.fetch.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:5173',
      'http://127.0.0.1:5173/health',
    ]);
    expect(f.pause).not.toHaveBeenCalled();
  });

  it('retries a slow server without overlapping polling attempts', async () => {
    const f = fixture();
    f.fetch.mockRejectedValueOnce(new Error('connection refused'));
    await expect(waitForStartup(f)).resolves.toBe(true);
    expect(f.pause).toHaveBeenCalledTimes(1);
  });

  it.each([
    {},
    { service: 'another app', status: 'alive' },
    { service: 'PicFind', status: 'failed' },
  ])(
    'does not accept a frontend fallback or unrelated API: %j',
    async (health) => {
      const f = fixture(health);
      await expect(waitForStartup(f)).rejects.toThrow('startup timed out');
      expect(f.fetch).toHaveBeenCalledTimes(6);
      expect(f.pause).toHaveBeenCalledTimes(2);
    },
  );

  it('reports a failed web startup rather than silently stopping the poll', async () => {
    const f = fixture();
    f.fetch.mockImplementation(
      async () => new Response('Unavailable', { status: 503 }),
    );
    await expect(waitForStartup(f)).rejects.toThrow('startup timed out');
    expect(f.fetch).toHaveBeenCalledTimes(3);
  });

  it('stops quietly without fetching when the launcher is shutting down', async () => {
    const f = fixture();
    await expect(
      waitForStartup({ ...f, isStopping: () => true }),
    ).resolves.toBe(false);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('does not announce startup if shutdown occurs during the health request', async () => {
    const f = fixture();
    let stopping = false;
    f.fetch.mockImplementation(async (url) => {
      if (String(url).endsWith('/health')) stopping = true;
      return Response.json({ service: 'PicFind', status: 'alive' });
    });
    await expect(
      waitForStartup({ ...f, isStopping: () => stopping }),
    ).resolves.toBe(false);
  });
});
