import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  markDeletedAccount,
  withAccountLock,
  withAccountLocks,
} from '../../apps/api/src/locks';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
describe('ordered account locks for shared questionnaire lifecycle', () => {
  it('serializes reciprocal participant order without deadlock', async () => {
    const a = randomUUID(),
      b = randomUUID(),
      entered = gate(),
      finish = gate();
    const events: string[] = [];
    const first = withAccountLocks([a, b], async () => {
      events.push('first-entered');
      entered.release();
      await finish.promise;
      events.push('first-finished');
    });
    await entered.promise;
    const second = withAccountLocks([b, a], async () => {
      events.push('second-entered');
    });
    finish.release();
    await Promise.all([first, second]);
    expect(events).toEqual([
      'first-entered',
      'first-finished',
      'second-entered',
    ]);
  });
  it('deduplicates repeated participant IDs', async () => {
    const id = randomUUID();
    expect(await withAccountLocks([id, id, id], async () => 'once')).toBe(
      'once',
    );
  });
  it('releases every acquired account when the operation rejects', async () => {
    const a = randomUUID(),
      b = randomUUID();
    await expect(
      withAccountLocks([a, b], async () => {
        throw new Error('Synthetic persistence failure.');
      }),
    ).rejects.toThrow('Synthetic persistence failure.');
    expect(await withAccountLock(a, async () => 'available')).toBe('available');
    expect(await withAccountLocks([b, a], async () => 'available')).toBe(
      'available',
    );
  });
  it('allows explicitly scoped deleted-recipient cleanup while rejecting normal writes and deleted owners', async () => {
    const owner = randomUUID(),
      recipient = randomUUID();
    markDeletedAccount(recipient);
    await expect(
      withAccountLocks([owner, recipient], async () => 'write'),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      await withAccountLocks([owner, recipient], async () => 'cleanup', {
        allowDeleted: [recipient],
      }),
    ).toBe('cleanup');
    markDeletedAccount(owner);
    await expect(
      withAccountLocks([owner, recipient], async () => 'cleanup', {
        allowDeleted: [recipient],
      }),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('shares queues with existing single-account operations', async () => {
    const a = `a-${randomUUID()}`,
      b = `b-${randomUUID()}`,
      entered = gate(),
      finish = gate();
    const events: string[] = [];
    const single = withAccountLock(b, async () => {
      entered.release();
      await finish.promise;
      events.push('single-finished');
    });
    await entered.promise;
    const multiple = withAccountLocks([b, a], async () =>
      events.push('multiple'),
    );
    finish.release();
    await Promise.all([single, multiple]);
    expect(events).toEqual(['single-finished', 'multiple']);
  });
  it('checks deletion after a queued operation obtains the account', async () => {
    const a = randomUUID(),
      b = randomUUID(),
      entered = gate(),
      finish = gate();
    const deletion = withAccountLock(a, async () => {
      entered.release();
      await finish.promise;
      markDeletedAccount(a);
    });
    await entered.promise;
    const write = withAccountLocks([a, b], async () => 'unexpected');
    finish.release();
    await deletion;
    await expect(write).rejects.toMatchObject({ status: 401 });
    expect(await withAccountLock(b, async () => 'released')).toBe('released');
  });
  it('rejects empty, unbounded or mis-scoped lock requests', () => {
    for (const ids of [
      [],
      [''],
      Array.from({ length: 202 }, (_, i) => String(i)),
    ])
      expect(() => withAccountLocks(ids, async () => undefined)).toThrow();
    expect(() =>
      withAccountLocks(['owner'], async () => undefined, {
        allowDeleted: ['someone-else'],
      }),
    ).toThrow();
  });
});
