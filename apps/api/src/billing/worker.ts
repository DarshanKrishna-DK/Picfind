import { randomUUID } from 'node:crypto';
import type { BillingAccount, BillingTransaction } from './model.js';
import type { BillingService } from './service.js';

const LEASE_MS = 120_000;
const COMPLETE_DELAY = 6 * 60 * 60_000;
interface Sweep {
  cursor?: string;
  token?: string;
  leaseUntil: number;
  nextSweepAt: number;
}
export interface BillingWorkerStatus {
  enabled: boolean;
  running: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  error: string | null;
}
type Report = (event: {
  event: 'billing.reconciliation.failed' | 'billing.reconciliation.unavailable';
  accountRef?: string;
  retryAt?: string;
}) => void;

/** One saved account per step. All provider operations are reads via reconcile(). */
export class BillingReconciliationWorker {
  private readonly sweepKey: string;
  private readonly systemOwner: string;
  private active: Promise<void> | undefined;
  private stopped = false;
  private current: BillingWorkerStatus = {
    enabled: true,
    running: false,
    lastSuccessAt: null,
    lastFailureAt: null,
    error: null,
  };
  constructor(
    private readonly billing: BillingService,
    private readonly report: Report = (event) =>
      console.warn(JSON.stringify(event)),
    private readonly now: () => number = Date.now,
  ) {
    if (
      !billing.store.accountPage ||
      !billing.provider?.listPayments ||
      !billing.provider.readPayment
    )
      throw new Error(
        'Scheduled billing recovery requires persistent discovery and payment history support.',
      );
    this.sweepKey = billing.key('worker', 'reconciliation');
    this.systemOwner = `${billing.namespace}:__reconciliation__`;
  }
  status = (): BillingWorkerStatus => ({ ...this.current });
  step(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.active) return this.active;
    this.active = this.run().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }
  async stop() {
    this.stopped = true;
    await this.active;
  }
  private async owned(tx: BillingTransaction, token: string) {
    const state = await tx.get<Sweep>(this.sweepKey);
    if (!state || state.token !== token || state.leaseUntil <= this.now())
      throw new Error('Lease lost');
    return state;
  }
  private async run() {
    const { billing } = this;
    const token = randomUUID();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let renewal: Promise<void> | undefined;
    let leaseLost = false;
    this.current.running = true;
    try {
      const claimed = await billing.store.transaction(async (tx) => {
        const state = (await tx.get<Sweep>(this.sweepKey)) ?? {
          leaseUntil: 0,
          nextSweepAt: 0,
        };
        if (state.leaseUntil > this.now() || state.nextSweepAt > this.now())
          return null;
        state.token = token;
        state.leaseUntil = this.now() + LEASE_MS;
        await tx.put(this.sweepKey, this.systemOwner, 'event', state);
        return state;
      });
      if (!claimed) return;
      heartbeat = setInterval(() => {
        if (renewal || leaseLost) return;
        renewal = billing.store
          .transaction(async (tx) => {
            const state = await this.owned(tx, token);
            state.leaseUntil = this.now() + LEASE_MS;
            await tx.put(this.sweepKey, this.systemOwner, 'event', state);
          })
          .catch(() => {
            leaseLost = true;
          })
          .finally(() => {
            renewal = undefined;
          });
      }, LEASE_MS / 4);
      heartbeat.unref();
      const page = await billing.store.accountPage!(claimed.cursor);
      let cursor = claimed.cursor;
      let processed = false;
      for (const item of page.items) {
        if (leaseLost || this.stopped) break;
        cursor = item.id;
        const prefix = `${billing.namespace}:`;
        if (!item.ownerKey.startsWith(prefix)) continue;
        const owner = item.ownerKey.slice(prefix.length);
        if (!owner || item.id !== billing.key('account', owner))
          throw new Error('Account binding mismatch');
        const due = await billing.store.transaction(async (tx) => {
          await this.owned(tx, token);
          const account = await tx.get<BillingAccount>(item.id);
          if (!account) return false;
          if (account.ownerId !== owner)
            throw new Error('Account binding mismatch');
          if (account.deletionPendingAt) return false;
          const schedule = account.backgroundReconciliation;
          if (
            schedule &&
            (!Number.isFinite(Date.parse(schedule.nextAttemptAt)) ||
              !Number.isSafeInteger(schedule.failures) ||
              schedule.failures < 0)
          )
            throw new Error('Invalid saved schedule');
          return !schedule || Date.parse(schedule.nextAttemptAt) <= this.now();
        });
        if (!due) continue;
        let failed = false;
        try {
          await billing.reconcile(owner);
        } catch {
          failed = true;
        }
        if (leaseLost) throw new Error('Lease lost');
        const retryAt = await billing.store.transaction(async (tx) => {
          await this.owned(tx, token);
          const account = await tx.get<BillingAccount>(item.id);
          if (!account) return null;
          if (account.ownerId !== owner)
            throw new Error('Account binding mismatch');
          const previous = account.backgroundReconciliation;
          const failures = failed
            ? Math.min((previous?.failures ?? 0) + 1, 20)
            : 0;
          const delay = failed
            ? Math.min(COMPLETE_DELAY, 60_000 * 2 ** (failures - 1))
            : account.paymentHistory?.status === 'running'
              ? 60_000
              : COMPLETE_DELAY;
          const nextAttemptAt = new Date(this.now() + delay).toISOString();
          account.backgroundReconciliation = {
            ...previous,
            nextAttemptAt,
            failures,
            ...(failed
              ? { lastFailureAt: new Date(this.now()).toISOString() }
              : { lastSuccessAt: new Date(this.now()).toISOString() }),
          };
          account.revision += 1;
          await tx.put(item.id, item.ownerKey, 'account', account);
          return nextAttemptAt;
        });
        if (failed) {
          this.current.lastFailureAt = new Date(this.now()).toISOString();
          this.current.error = 'BILLING_ACCOUNT_RECONCILIATION_FAILED';
          this.report({
            event: 'billing.reconciliation.failed',
            accountRef: item.id,
            ...(retryAt ? { retryAt } : {}),
          });
        } else {
          this.current.lastSuccessAt = new Date(this.now()).toISOString();
          this.current.error = null;
        }
        processed = true;
        break;
      }
      if (leaseLost) throw new Error('Lease lost');
      await billing.store.transaction(async (tx) => {
        const state = await this.owned(tx, token);
        // A partial page must not skip accounts after the one just processed.
        const end =
          page.end && (!processed || cursor === page.items.at(-1)?.id);
        if (end) {
          delete state.cursor;
          state.nextSweepAt = this.now() + 60_000;
        } else if (cursor) state.cursor = cursor;
        delete state.token;
        state.leaseUntil = 0;
        await tx.put(this.sweepKey, this.systemOwner, 'event', state);
      });
    } catch {
      this.current.error = 'BILLING_RECONCILIATION_UNAVAILABLE';
      this.current.lastFailureAt = new Date(this.now()).toISOString();
      this.report({ event: 'billing.reconciliation.unavailable' });
      // Keep the lease/cursor after uncertainty. A later process resumes after expiry.
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      await renewal;
      this.current.running = false;
    }
  }
}

export function startBillingReconciliation(
  billing: BillingService | undefined,
  enabled: boolean,
) {
  const disabled: BillingWorkerStatus = {
    enabled: false,
    running: false,
    lastSuccessAt: null,
    lastFailureAt: null,
    error: null,
  };
  if (!enabled)
    return { status: () => ({ ...disabled }), stop: async () => {} };
  if (!billing)
    throw new Error('Enable billing before scheduled reconciliation.');
  const worker = new BillingReconciliationWorker(billing);
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    await worker.step();
    if (!stopping) {
      timer = setTimeout(() => {
        void tick();
      }, 10_000);
      timer.unref();
    }
  };
  void tick();
  return {
    status: worker.status,
    stop: async () => {
      stopping = true;
      if (timer) clearTimeout(timer);
      await worker.stop();
    },
  };
}
