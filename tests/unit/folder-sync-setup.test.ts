import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// Execute the actual setup logic with synthetic configuration and a fake HTTP
// boundary. Remove only its imports/env loader: never read the real .env here.
const source = readFileSync(
  new URL('../../scripts/setup-folder-sync.mjs', import.meta.url),
  'utf8',
)
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/^loadEnvFile\(.*\);\r?\n/gm, '');

function fixture(
  mode: 'ready' | 'delayed' | 'failed' | 'pending' = 'ready',
  privateTable = true,
) {
  const polls = new Map<string, number>();
  const info = vi.fn();
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.replace(/^\/v1/, '');
    const table = path.includes('/tables/folder-sync-files')
      ? 'folder-sync-files'
      : 'folder-syncs';
    const columns =
      table === 'folder-syncs'
        ? ['ownerId', 'actorId', 'eventId', 'status', 'payload', 'nextRunAt']
        : ['ownerId', 'syncId'];
    const indexes =
      table === 'folder-syncs'
        ? ['status_due', 'owner_event', 'actor_status']
        : ['owner_sync'];
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status });
    if (init.method === 'POST') return json({}, 201);
    if (/\/indexes\/[^/]+$/.test(path)) return json({}, 404);
    if (path.endsWith('/indexes')) {
      const count = (polls.get(table) ?? 0) + 1;
      polls.set(table, count);
      const status =
        mode === 'failed'
          ? 'failed'
          : mode === 'pending' || (mode === 'delayed' && count === 1)
            ? 'processing'
            : 'available';
      return json({ indexes: indexes.map((key) => ({ key, status })) });
    }
    if (path.endsWith('/columns'))
      return json({
        columns: columns.map((key) => ({ key, status: 'available' })),
      });
    if (path.includes('/columns/')) {
      const key = path.split('/').at(-1);
      return json({
        key,
        type: key === 'nextRunAt' ? 'datetime' : 'string',
        size: 65535,
        required: true,
      });
    }
    if (path.includes('/tables/'))
      return json({
        rowSecurity: privateTable,
        $permissions: privateTable ? [] : ['read("any")'],
      });
    return json({ $id: 'picfind-library' });
  });
  const execute = () =>
    runInNewContext(`(async () => {${source}\n})()`, {
      process: {
        env: {
          APPWRITE_ENDPOINT: 'https://synthetic.appwrite.test/v1',
          APPWRITE_PROJECT_ID: 'synthetic-project',
          APPWRITE_API_KEY: 'synthetic-not-a-secret',
        },
      },
      fetch,
      AbortSignal,
      console: { info },
      setTimeout: (callback: () => void) => {
        callback();
        return 0;
      },
    }) as Promise<void>;
  return { execute, fetch, info, polls };
}

describe('folder-sync setup against synthetic HTTP only', () => {
  it('reports success only when both tables have available indexes', async () => {
    const f = fixture();
    await f.execute();
    expect([...f.polls.keys()]).toEqual(['folder-syncs', 'folder-sync-files']);
    expect(f.info).toHaveBeenCalledOnce();
    expect(
      f.fetch.mock.calls.filter(([, init]) => init.method === 'POST'),
    ).toHaveLength(4);
  });
  it('waits for asynchronous index provisioning on each table', async () => {
    const f = fixture('delayed');
    await f.execute();
    expect([...f.polls.values()]).toEqual([2, 2]);
    expect(f.info).toHaveBeenCalledOnce();
  });
  it('does not advertise success for a failed index', async () => {
    const f = fixture('failed');
    await expect(f.execute()).rejects.toThrow('Index provisioning failed');
    expect(f.info).not.toHaveBeenCalled();
  });
  it('bounds the wait and leaves a retry instruction for pending indexes', async () => {
    const f = fixture('pending');
    await expect(f.execute()).rejects.toThrow('Run setup again later');
    expect(f.polls.get('folder-syncs')).toBe(20);
    expect(f.info).not.toHaveBeenCalled();
  });
  it('rejects a public table without attempting schema writes', async () => {
    const f = fixture('ready', false);
    await expect(f.execute()).rejects.toThrow(
      'Refusing to use non-private table',
    );
    expect(f.fetch.mock.calls.some(([, init]) => init.method !== 'GET')).toBe(
      false,
    );
    expect(f.info).not.toHaveBeenCalled();
  });
});
