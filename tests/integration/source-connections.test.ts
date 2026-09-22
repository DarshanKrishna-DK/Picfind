import { describe, expect, it, vi } from 'vitest';
import {
  SourceConnections,
  sourceConnectionId,
  type SourceConnectionRecord,
  type SourceConnectionStore,
  type SourceRefresh,
} from '../../apps/api/src/source-connections.js';

class Store implements SourceConnectionStore {
  rows = new Map<string, SourceConnectionRecord>();
  private tail: Promise<unknown> = Promise.resolve();
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
  ): Promise<T> {
    const result = this.tail.then(() => {
      const change = operation(structuredClone(this.rows.get(id)));
      if (change.record) this.rows.set(id, structuredClone(change.record));
      return change.result;
    });
    this.tail = result.catch(() => {});
    return result;
  }
}
function fixture() {
  const store = new Store();
  let now = 1000000;
  const refresh = vi.fn<SourceRefresh>(async () => ({
    accessToken: 'new-access-private',
    refreshToken: 'rotated-refresh-private',
    accessExpiresAt: now + 3600000,
  }));
  const vault = new SourceConnections(
    store,
    'ab'.repeat(32),
    refresh,
    () => now,
  );
  return {
    store,
    refresh,
    vault,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
describe('persistent encrypted source connections with synthetic OAuth exchanges', () => {
  it('stores only ciphertext and isolates owners and providers', async () => {
    const f = fixture();
    await f.vault.connect('owner', 'dropbox', {
      accessToken: 'private-access',
      refreshToken: 'private-refresh',
      accessExpiresAt: f.now() + 3600000,
    });
    expect(JSON.stringify([...f.store.rows.values()])).not.toContain(
      'private-access',
    );
    expect(JSON.stringify([...f.store.rows.values()])).not.toContain(
      'private-refresh',
    );
    expect(await f.vault.status('owner', 'dropbox')).toMatchObject({
      connected: true,
      persistent: true,
      backgroundAccess: true,
    });
    expect(
      JSON.stringify(await f.vault.status('owner', 'dropbox')),
    ).not.toContain('private');
    await expect(f.vault.access('other', 'dropbox')).rejects.toMatchObject({
      code: 'SOURCE_RECONNECT_REQUIRED',
    });
    await expect(f.vault.access('owner', 'box')).rejects.toMatchObject({
      code: 'SOURCE_RECONNECT_REQUIRED',
    });
  });
  it('a restarted process can reuse a stored connection without token cookies', async () => {
    const f = fixture();
    await f.vault.connect('owner', 'drive', {
      accessToken: 'private-access',
      accessExpiresAt: f.now() + 3600000,
    });
    const restarted = new SourceConnections(
      f.store,
      'ab'.repeat(32),
      f.refresh,
      f.now,
    );
    expect((await restarted.access('owner', 'drive')).accessToken).toBe(
      'private-access',
    );
    expect(f.refresh).not.toHaveBeenCalled();
  });
  it('coalesces local refreshes and preserves the rotated Box token across restarts', async () => {
    const f = fixture();
    await f.vault.connect('owner', 'box', {
      refreshToken: 'old-private',
      accessExpiresAt: 0,
    });
    const [a, b] = await Promise.all([
      f.vault.access('owner', 'box'),
      f.vault.access('owner', 'box'),
    ]);
    expect(a.accessToken).toBe('new-access-private');
    expect(b).toEqual(a);
    expect(f.refresh).toHaveBeenCalledTimes(1);
    f.advance(3600000);
    await new SourceConnections(
      f.store,
      'ab'.repeat(32),
      f.refresh,
      f.now,
    ).access('owner', 'box');
    expect(f.refresh).toHaveBeenLastCalledWith(
      'box',
      'rotated-refresh-private',
    );
  });
  it('a second process cannot consume the same rotating refresh token', async () => {
    const f = fixture(),
      started = gate(),
      finish = gate();
    f.refresh.mockImplementationOnce(async () => {
      started.release();
      await finish.promise;
      return {
        accessToken: 'new',
        refreshToken: 'rotated',
        accessExpiresAt: f.now() + 3600000,
      };
    });
    await f.vault.connect('owner', 'box', {
      refreshToken: 'old',
      accessExpiresAt: 0,
    });
    const first = f.vault.access('owner', 'box');
    await started.promise;
    await expect(
      new SourceConnections(f.store, 'ab'.repeat(32), f.refresh, f.now).access(
        'owner',
        'box',
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_REFRESH_PENDING' });
    finish.release();
    await first;
    expect(f.refresh).toHaveBeenCalledTimes(1);
  });
  it('disconnect fences an in-flight refresh and removes encrypted credentials', async () => {
    const f = fixture(),
      started = gate(),
      finish = gate();
    f.refresh.mockImplementationOnce(async () => {
      started.release();
      await finish.promise;
      return {
        accessToken: 'late',
        refreshToken: 'late-refresh',
        accessExpiresAt: f.now() + 3600000,
      };
    });
    await f.vault.connect('owner', 'box', {
      refreshToken: 'old',
      accessExpiresAt: 0,
    });
    const refreshing = f.vault.access('owner', 'box');
    const rejected = expect(refreshing).rejects.toMatchObject({
      code: 'SOURCE_CONNECTION_CHANGED',
    });
    await started.promise;
    await f.vault.disconnect('owner', 'box');
    finish.release();
    await rejected;
    expect(
      f.store.rows.get(sourceConnectionId('owner', 'box'))?.encryptedGrant,
    ).toBeUndefined();
    expect((await f.vault.status('owner', 'box')).connected).toBe(false);
    await expect(f.vault.access('owner', 'box')).rejects.toMatchObject({
      code: 'SOURCE_RECONNECT_REQUIRED',
    });
  });
  it('an old refresh response cannot overwrite a newly connected account', async () => {
    const f = fixture(),
      started = gate(),
      finish = gate();
    f.refresh.mockImplementationOnce(async () => {
      started.release();
      await finish.promise;
      return {
        accessToken: 'late-old',
        refreshToken: 'late-old-refresh',
        accessExpiresAt: f.now() + 3600000,
      };
    });
    await f.vault.connect('owner', 'onedrive', {
      refreshToken: 'old',
      accessExpiresAt: 0,
    });
    const refreshing = f.vault.access('owner', 'onedrive');
    const rejected = expect(refreshing).rejects.toMatchObject({
      code: 'SOURCE_CONNECTION_CHANGED',
    });
    await started.promise;
    await f.vault.connect('owner', 'onedrive', {
      accessToken: 'replacement',
      accessExpiresAt: f.now() + 3600000,
    });
    finish.release();
    await rejected;
    expect((await f.vault.access('owner', 'onedrive')).accessToken).toBe(
      'replacement',
    );
  });
  it('never repeats an uncertain refresh exchange', async () => {
    const f = fixture();
    await f.vault.connect('owner', 'box', {
      refreshToken: 'single-use',
      accessExpiresAt: 0,
    });
    f.refresh.mockRejectedValueOnce(new Error('Synthetic lost provider reply'));
    await expect(f.vault.access('owner', 'box')).rejects.toMatchObject({
      code: 'SOURCE_RECONNECT_REQUIRED',
    });
    await expect(f.vault.access('owner', 'box')).rejects.toMatchObject({
      code: 'SOURCE_RECONNECT_REQUIRED',
    });
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(
      f.store.rows.get(sourceConnectionId('owner', 'box'))?.encryptedGrant,
    ).toBeUndefined();
  });
  it('reconciles a lost refresh commit acknowledgement without refreshing again', async () => {
    const f = fixture();
    await f.vault.connect('owner', 'box', {
      refreshToken: 'old',
      accessExpiresAt: 0,
    });
    const mutate = f.store.mutate.bind(f.store);
    let lost = false;
    f.store.mutate = async (id, operation) => {
      const result = await mutate(id, operation);
      if (f.store.rows.get(id)?.lastRefreshAttempt && !lost) {
        lost = true;
        throw new Error('Synthetic lost commit reply');
      }
      return result;
    };
    expect((await f.vault.access('owner', 'box')).accessToken).toBe(
      'new-access-private',
    );
    expect(f.refresh).toHaveBeenCalledTimes(1);
  });
  it('an abandoned refresh claim requires reconnect instead of replay after restart', async () => {
    const f = fixture();
    await f.vault.connect('owner', 'box', {
      refreshToken: 'old',
      accessExpiresAt: 0,
    });
    const id = sourceConnectionId('owner', 'box');
    f.store.rows.set(id, {
      ...f.store.rows.get(id)!,
      state: 'refreshing',
      refreshAttempt: 'abandoned',
      refreshStartedAt: f.now(),
    });
    f.advance(61000);
    await expect(f.vault.access('owner', 'box')).rejects.toMatchObject({
      code: 'SOURCE_RECONNECT_REQUIRED',
    });
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.store.rows.get(id)?.encryptedGrant).toBeUndefined();
  });
  it('cannot transplant ciphertext between owners or connection generations', async () => {
    const f = fixture();
    await f.vault.connect('owner', 'drive', {
      accessToken: 'secret',
      accessExpiresAt: f.now() + 3600000,
    });
    const source = f.store.rows.get(sourceConnectionId('owner', 'drive'))!;
    f.store.rows.set(sourceConnectionId('other', 'drive'), {
      ...source,
      id: sourceConnectionId('other', 'drive'),
      ownerId: 'other',
    });
    await expect(f.vault.access('other', 'drive')).rejects.toMatchObject({
      code: 'SOURCE_RECONNECT_REQUIRED',
    });
    expect((await f.vault.status('other', 'drive')).reconnectRequired).toBe(
      true,
    );
    f.store.rows.set(source.id, { ...source, generation: 'different' });
    await expect(f.vault.access('owner', 'drive')).rejects.toMatchObject({
      code: 'SOURCE_RECONNECT_REQUIRED',
    });
  });
  it('disconnecting and removing one account does not change another', async () => {
    const f = fixture();
    for (const owner of ['owner', 'other'])
      await f.vault.connect(owner, 'dropbox', {
        accessToken: owner,
        accessExpiresAt: f.now() + 3600000,
      });
    await f.vault.disconnectOwner('owner');
    await f.vault.removeOwner('owner');
    expect(f.store.rows.has(sourceConnectionId('owner', 'dropbox'))).toBe(
      false,
    );
    expect((await f.vault.access('other', 'dropbox')).accessToken).toBe(
      'other',
    );
  });
  it('rejects stale job generations before any provider request', async () => {
    const f = fixture();
    const first = await f.vault.connect('owner', 'drive', {
      refreshToken: 'old',
      accessExpiresAt: 0,
    });
    await f.vault.connect('owner', 'drive', {
      refreshToken: 'new',
      accessExpiresAt: 0,
    });
    await expect(
      f.vault.access('owner', 'drive', first.generation),
    ).rejects.toMatchObject({ code: 'SOURCE_CONNECTION_CHANGED' });
    expect(f.refresh).not.toHaveBeenCalled();
  });
});
