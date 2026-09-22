import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app.js';
import { BillingService } from '../../apps/api/src/billing/service.js';
import {
  BillingReconciliationWorker,
  startBillingReconciliation,
} from '../../apps/api/src/billing/worker.js';
import {
  billingId,
  type BillingAccount,
  type BillingKind,
  type BillingProvider,
  type BillingStore,
  type BillingTransaction,
} from '../../apps/api/src/billing/model.js';

class Store implements BillingStore {
  rows = new Map<
    string,
    { owner: string; kind: BillingKind; value: unknown }
  >();
  private tail: Promise<unknown> = Promise.resolve();
  failCommit = false;
  transaction<T>(work: (tx: BillingTransaction) => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      const draft = structuredClone(this.rows);
      const result = await work({
        get: async <V>(id: string) =>
          structuredClone(draft.get(id)?.value ?? null) as V | null,
        list: async <V>(owner: string, kind: BillingKind) =>
          [...draft.values()]
            .filter((r) => r.owner === owner && r.kind === kind)
            .map((r) => structuredClone(r.value) as V),
        put: async (id, owner, kind, value) => {
          draft.set(id, { owner, kind, value: structuredClone(value) });
        },
      });
      if (this.failCommit) {
        this.failCommit = false;
        throw new Error('Synthetic storage outage');
      }
      this.rows = draft;
      return result;
    });
    this.tail = next.catch(() => {});
    return next;
  }
  accountPage = vi.fn(async (after?: string) => {
    const rows = [...this.rows.entries()]
      .filter(([id, row]) => row.kind === 'account' && id > (after ?? ''))
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 25);
    return {
      items: rows.map(([id, row]) => ({ id, ownerKey: row.owner })),
      end: rows.length < 25,
    };
  });
}
async function fixture(count = 1) {
  let time = Date.parse('2026-09-21T12:00:00Z');
  const store = new Store();
  const provider: BillingProvider = {
    checkout: vi.fn(),
    portal: vi.fn(),
    verify: vi.fn(),
    listPayments: vi.fn(async () => ({ items: [], hasMore: false })),
    readPayment: vi.fn(),
  };
  const service = new BillingService(store, provider, {}, 'test_mode', false);
  const users = Array.from({ length: count }, () => randomUUID());
  for (const owner of users) {
    await service.summary(owner);
    await store.transaction(async (tx) => {
      const id = service.key('account', owner);
      const account = (await tx.get<BillingAccount>(id))!;
      account.customerId = `cus_${owner}`;
      await tx.put(id, `test_mode:${owner}`, 'account', account);
    });
  }
  const ordered = users.sort((a, b) =>
    service.key('account', a).localeCompare(service.key('account', b)),
  );
  const logs = vi.fn();
  const worker = () =>
    new BillingReconciliationWorker(service, logs, () => time);
  const account = (owner = ordered[0]!) =>
    structuredClone(
      store.rows.get(service.key('account', owner))!.value,
    ) as BillingAccount;
  return {
    store,
    service,
    provider,
    logs,
    worker,
    account,
    users: ordered,
    advance: (ms: number) => {
      time += ms;
    },
    now: () => time,
  };
}
afterEach(() => vi.useRealTimers());
describe('scheduled billing recovery with synthetic storage/provider', () => {
  it('recovers one account and persists the next check without enabling checkout', async () => {
    const f = await fixture();
    await f.worker().step();
    expect(f.provider.listPayments).toHaveBeenCalledTimes(1);
    expect(f.account().paymentHistory?.status).toBe('complete');
    expect(
      Date.parse(f.account().backgroundReconciliation!.nextAttemptAt) - f.now(),
    ).toBe(6 * 3600_000);
    expect(f.provider.checkout).not.toHaveBeenCalled();
    expect(f.service.checkoutEnabled).toBe(false);
  });
  it('advances at most one due owner and resumes the sweep in a new worker', async () => {
    const f = await fixture(3);
    await f.worker().step();
    expect(f.account(f.users[1]!).backgroundReconciliation).toBeUndefined();
    await f.worker().step();
    expect(f.provider.listPayments).toHaveBeenCalledTimes(2);
    expect(f.account(f.users[1]!).backgroundReconciliation).toBeDefined();
    expect(f.account(f.users[2]!).backgroundReconciliation).toBeUndefined();
  });
  it('honors persisted cooldown across restart and retries after six hours', async () => {
    const f = await fixture();
    await f.worker().step();
    await f.worker().step();
    f.advance(60_000);
    await f.worker().step();
    expect(f.provider.listPayments).toHaveBeenCalledTimes(1);
    f.advance(6 * 3600_000);
    await f.worker().step();
    expect(f.provider.listPayments).toHaveBeenCalledTimes(2);
  });
  it('continues partial payment pages on a later sweep instead of starting again', async () => {
    const f = await fixture();
    vi.mocked(f.provider.listPayments!).mockResolvedValueOnce({
      items: [{ id: 'unrelated' }],
      hasMore: true,
    });
    await f.worker().step();
    expect(f.account().paymentHistory?.page).toBe(1);
    expect(
      Date.parse(f.account().backgroundReconciliation!.nextAttemptAt) - f.now(),
    ).toBe(60_000);
    f.advance(60_000);
    await f.worker().step();
    expect(f.provider.listPayments).toHaveBeenLastCalledWith(
      expect.any(String),
      1,
      expect.any(String),
    );
    expect(f.account().paymentHistory?.status).toBe('complete');
  });
  it('persists failure backoff and does not starve another owner', async () => {
    const f = await fixture(2);
    vi.mocked(f.provider.listPayments!).mockRejectedValueOnce(
      new Error('secret provider body'),
    );
    const first = f.worker();
    await first.step();
    expect(first.status().error).toBe('BILLING_ACCOUNT_RECONCILIATION_FAILED');
    expect(f.account().backgroundReconciliation?.failures).toBe(1);
    expect(JSON.stringify(f.logs.mock.calls)).not.toContain('secret');
    expect(JSON.stringify(first.status())).not.toContain(f.users[0]!);
    await f.worker().step();
    expect(f.account(f.users[1]!).paymentHistory?.status).toBe('complete');
    f.advance(60_000);
    vi.mocked(f.provider.listPayments!).mockRejectedValueOnce(
      new Error('outage'),
    );
    await f.worker().step();
    expect(f.account().backgroundReconciliation?.failures).toBe(2);
    expect(
      Date.parse(f.account().backgroundReconciliation!.nextAttemptAt) - f.now(),
    ).toBe(120_000);
  });
  it('caps repeated failure backoff and resets it after recovery', async () => {
    const f = await fixture();
    const row = f.store.rows.get(f.service.key('account', f.users[0]!))!;
    (row.value as BillingAccount).backgroundReconciliation = {
      failures: 19,
      nextAttemptAt: new Date(f.now()).toISOString(),
    };
    vi.mocked(f.provider.listPayments!).mockRejectedValueOnce(
      new Error('outage'),
    );
    await f.worker().step();
    expect(f.account().backgroundReconciliation?.failures).toBe(20);
    expect(
      Date.parse(f.account().backgroundReconciliation!.nextAttemptAt) - f.now(),
    ).toBe(6 * 3600_000);
    f.advance(6 * 3600_000);
    await f.worker().step();
    expect(f.account().backgroundReconciliation?.failures).toBe(0);
  });
  it('serializes two independent workers with the durable lease', async () => {
    const f = await fixture();
    let finish!: () => void;
    vi.mocked(f.provider.listPayments!).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { items: [], hasMore: false };
    });
    const a = f.worker();
    const pending = a.step();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(a.step()).toBe(pending);
    await f.worker().step();
    expect(f.provider.listPayments).toHaveBeenCalledTimes(1);
    finish();
    await pending;
  });
  it('retains cursor after discovery outage and recovers an expired lease', async () => {
    const f = await fixture();
    f.store.accountPage.mockRejectedValueOnce(
      new Error('database credential SECRET'),
    );
    const a = f.worker();
    await a.step();
    expect(a.status().error).toBe('BILLING_RECONCILIATION_UNAVAILABLE');
    await f.worker().step();
    expect(f.provider.listPayments).not.toHaveBeenCalled();
    f.advance(120_001);
    await f.worker().step();
    expect(f.provider.listPayments).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.logs.mock.calls)).not.toContain('SECRET');
  });
  it('does not checkpoint under a stolen or expired lease', async () => {
    const f = await fixture();
    vi.mocked(f.provider.listPayments!).mockImplementationOnce(async () => {
      const key = f.service.key('worker', 'reconciliation');
      await f.store.transaction(async (tx) => {
        const sweep = await tx.get<Record<string, unknown>>(key);
        await tx.put(key, 'test_mode:__reconciliation__', 'event', {
          ...sweep,
          token: 'other-process',
        });
      });
      return { items: [], hasMore: false };
    });
    const worker = f.worker();
    await worker.step();
    expect(worker.status().error).toBe('BILLING_RECONCILIATION_UNAVAILABLE');
    expect(f.account().backgroundReconciliation).toBeUndefined();
    expect(f.account().paymentHistory?.status).toBe('complete');
  });
  it('heartbeats a long-running provider request and stop waits for it', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    let finish!: () => void;
    vi.mocked(f.provider.listPayments!).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { items: [], hasMore: false };
    });
    const worker = f.worker();
    const pending = worker.step();
    await vi.advanceTimersByTimeAsync(0);
    f.advance(90_000);
    await vi.advanceTimersByTimeAsync(30_000);
    const sweep = f.store.rows.get(f.service.key('worker', 'reconciliation'))!
      .value as { leaseUntil: number };
    expect(sweep.leaseUntil).toBe(f.now() + 120_000);
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await pending;
    await stopping;
    await worker.step();
    expect(f.provider.listPayments).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not overwrite concurrent account fields when saving schedule', async () => {
    const f = await fixture();
    vi.mocked(f.provider.listPayments!).mockImplementationOnce(async () => {
      await f.store.transaction(async (tx) => {
        const id = f.service.key('account', f.users[0]!);
        const account = (await tx.get<BillingAccount>(id))!;
        account.storedBytes = 12345;
        await tx.put(id, `test_mode:${account.ownerId}`, 'account', account);
      });
      return { items: [], hasMore: false };
    });
    await f.worker().step();
    expect(f.account().storedBytes).toBe(12345);
  });
  it('never processes other environments or deletion-fenced owners', async () => {
    const f = await fixture();
    const owner = f.users[0]!;
    const row = f.store.rows.get(f.service.key('account', owner))!;
    (row.value as BillingAccount).deletionPendingAt = new Date().toISOString();
    f.store.rows.set(billingId('live_mode', 'account', 'foreign'), {
      owner: 'live_mode:foreign',
      kind: 'account',
      value: { ownerId: 'foreign' },
    });
    await f.worker().step();
    expect(f.provider.listPayments).not.toHaveBeenCalled();
  });
  it('fails closed for corrupted account bindings', async () => {
    const f = await fixture();
    (
      f.store.rows.get(f.service.key('account', f.users[0]!))!
        .value as BillingAccount
    ).ownerId = 'foreign';
    const worker = f.worker();
    await worker.step();
    expect(worker.status().error).toBe('BILLING_RECONCILIATION_UNAVAILABLE');
    expect(f.provider.listPayments).not.toHaveBeenCalled();
  });
  it('retains schedule on transaction failure and retries idempotently', async () => {
    const f = await fixture();
    const realReconcile = f.service.reconcile.bind(f.service);
    vi.spyOn(f.service, 'reconcile').mockImplementationOnce(async (owner) => {
      const summary = await realReconcile(owner);
      f.store.failCommit = true;
      return summary;
    });
    await f.worker().step();
    expect(f.account().backgroundReconciliation).toBeUndefined();
    f.advance(120_001);
    await f.worker().step();
    expect(f.account().backgroundReconciliation?.failures).toBe(0);
  });
  it('is disabled by default and refuses unsupported explicit activation', async () => {
    const disabled = startBillingReconciliation(undefined, false);
    expect(disabled.status().enabled).toBe(false);
    await disabled.stop();
    expect(() => startBillingReconciliation(undefined, true)).toThrow(
      'Enable billing',
    );
    const f = await fixture();
    const unsupported = new BillingService(
      f.store,
      undefined,
      {},
      'test_mode',
      false,
    );
    expect(() => new BillingReconciliationWorker(unsupported)).toThrow(
      'history support',
    );
  });
  it('stops the runtime polling timer without starting another sweep', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const runtime = startBillingReconciliation(f.service, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.provider.listPayments).toHaveBeenCalledTimes(1);
    await runtime.stop();
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(f.provider.listPayments).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('exposes separate sanitized operational health without blocking general liveness', async () => {
    const f = await fixture();
    vi.mocked(f.provider.listPayments!).mockRejectedValueOnce(
      new Error('secret'),
    );
    const worker = f.worker();
    await worker.step();
    const app = createApp(undefined, {}, undefined, {
      billingReconciliation: worker.status,
    });
    const response = await request(app).get('/health/billing').expect(503);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(response.body)).not.toContain('secret');
    expect(JSON.stringify(response.body)).not.toContain(f.users[0]!);
    await request(app).get('/health').expect(200);
    expect(
      (await request(createApp()).get('/health/billing').expect(200)).body,
    ).toEqual({ enabled: false });
  });
});
