import { randomUUID } from 'node:crypto';
import {
  assertCancellationResolved,
  beginSubscriptionCancellation,
  finishSubscriptionCancellation,
} from './cancellation-guard.js';
import { materializeAllowanceWindows } from './allowance-windows.js';
import { reserveScopedStorage, storageUsage } from './storage-scopes.js';
import { withAccountLock } from '../locks.js';
import { reconcilePaymentHistory } from './history.js';
import {
  observeSubscriptionPlan,
  subscriptionPeriod,
} from './plan-transitions.js';
import { ApiError, type AuthUser } from '../auth.js';
import type { StorageReservation } from './model.js';
import {
  billingId,
  grantScope,
  scopeAllows,
  isLegacyPlan,
  isSubscriptionPlan,
  type BillingScope,
  newGrant,
  remaining,
  type BillingAccount,
  type BillingOrder,
  type BillingProvider,
  type BillingStore,
  type BillingTransaction,
  type Currency,
  type Grant,
  type PlanId,
  type ProductMap,
  type VerifiedBillingEvent,
  type SubscriptionSnapshot,
} from './model.js';

interface DeliveryReservation {
  scope?: BillingScope;
  ownerId: string;
  bytes: number;
  status: 'reserved' | 'refunded';
  allocations: { grantId: string; bytes: number }[];
  createdAt: string;
  refundedAt?: string;
  reason?: 'upstream-http-failure' | 'metadata-mismatch';
}
export class BillingService {
  async commitEventImportPhoto(
    root: import('../library.js').LibraryRecord,
    source: import('../import-policy.js').ImportSource,
    fileId: string,
    photo: import('../library.js').LibraryRecord,
  ) {
    const { commitEventImportPhoto } =
      await import('./event-import-publication.js');
    return this.store.transaction(async (tx) => {
      const account = await this.account(tx, root.ownerId);
      this.assertPurchasesOpen(account);
      const actor = source.actorId ?? root.ownerId;
      if (actor !== root.ownerId)
        this.assertPurchasesOpen(await this.account(tx, actor));
      return commitEventImportPhoto(
        tx,
        this.namespace,
        account,
        this.roleCatalogEnabled ? 'organizer' : 'legacy',
        root,
        source,
        fileId,
        photo,
      );
    });
  }
  async assertImportAccounts(owner: string, actor: string) {
    return this.store.transaction(async (tx) => {
      this.assertPurchasesOpen(await this.account(tx, owner));
      if (actor !== owner)
        this.assertPurchasesOpen(await this.account(tx, actor));
    });
  }
  async stageEventImport(
    actor: string,
    root: import('../library.js').LibraryRecord,
    previousRequestId?: string,
  ) {
    const { stageEventImport } = await import('./event-import-staging.js');
    return this.store.transaction(async (tx) => {
      this.assertPurchasesOpen(await this.account(tx, root.ownerId));
      if (actor !== root.ownerId)
        this.assertPurchasesOpen(await this.account(tx, actor));
      return stageEventImport(tx, actor, root, previousRequestId);
    });
  }
  async stageFolderSyncImport(
    sync: import('../folder-sync.js').FolderSync,
    root: import('../library.js').LibraryRecord,
  ) {
    const { stageFolderSyncImport } = await import('./folder-sync-staging.js');
    return this.store.transaction(async (tx) => {
      this.assertPurchasesOpen(await this.account(tx, sync.ownerId));
      if (sync.actorId !== sync.ownerId)
        this.assertPurchasesOpen(await this.account(tx, sync.actorId));
      return stageFolderSyncImport(tx, this.namespace, sync, root);
    });
  }
  async assertAccountDeleting(owner: string) {
    return this.store.transaction(async (tx) => {
      const account = await tx.get<BillingAccount>(this.key('account', owner));
      if (!account?.deletionPendingAt)
        throw new ApiError(
          409,
          'ACCOUNT_DELETION_REQUIRED',
          'Start account deletion before removing its source records.',
        );
    });
  }
  async suppressFolderSyncPhoto(photo: import('../library.js').LibraryRecord) {
    const { suppressFolderSyncPhoto } =
      await import('./folder-sync-deletion.js');
    return this.store.transaction((tx) => suppressFolderSyncPhoto(tx, photo));
  }
  async resumeFolderSync(
    actor: string,
    eventId: string,
    snapshot: import('../folder-sync.js').FolderSync,
    requestId: string,
    recovery: import('../folder-sync-recovery.js').FolderSyncRecovery,
  ) {
    if (!this.roleCatalogEnabled)
      throw new ApiError(
        503,
        'FOLDER_SYNC_UNAVAILABLE',
        'Organizer folder syncing is not enabled.',
      );
    const { resumeFolderSync } = await import('./folder-sync-resume.js');
    return this.store.transaction((tx) =>
      resumeFolderSync(
        tx,
        this.namespace,
        actor,
        eventId,
        snapshot,
        requestId,
        recovery,
        (owner) => this.account(tx, owner),
      ),
    );
  }
  async createFolderSync(
    actor: string,
    eventId: string,
    input: import('./folder-sync-creation.js').CreateFolderSyncInput,
    expectedGrant: string,
  ) {
    if (!this.roleCatalogEnabled)
      throw new ApiError(
        503,
        'FOLDER_SYNC_UNAVAILABLE',
        'Organizer folder syncing is not enabled on this deployment.',
      );
    const { createFolderSync } = await import('./folder-sync-creation.js');
    return this.store.transaction((tx) =>
      createFolderSync(
        tx,
        this.namespace,
        actor,
        eventId,
        input,
        expectedGrant,
        (owner) => this.account(tx, owner),
      ),
    );
  }
  async authorizeFolderSync(sync: import('../folder-sync.js').FolderSync) {
    const { authorizeFolderSync } = await import('./folder-sync-policy.js');
    return this.store.transaction(async (tx) => {
      const owner = await this.account(tx, sync.ownerId);
      this.assertPurchasesOpen(owner);
      if (sync.actorId !== sync.ownerId)
        this.assertPurchasesOpen(await this.account(tx, sync.actorId));
      return authorizeFolderSync(tx, this.namespace, sync);
    });
  }
  async commitFolderSyncPhoto(
    sync: import('../folder-sync.js').FolderSync,
    root: import('../library.js').LibraryRecord,
    photo: import('../library.js').LibraryRecord,
  ) {
    const { commitFolderSyncPhoto } =
      await import('./folder-sync-publication.js');
    return this.store.transaction(async (tx) =>
      commitFolderSyncPhoto(
        tx,
        this.namespace,
        await this.account(tx, sync.ownerId),
        sync,
        root,
        photo,
      ),
    );
  }
  async eventMembers(owner: string, eventId: string) {
    const { listEventMembers } = await import('./event-memberships.js');
    return this.store.transaction((tx) => listEventMembers(tx, owner, eventId));
  }
  async inviteEventMember(
    owner: string,
    eventId: string,
    target: import('../auth.js').AuthUser,
  ) {
    const { inviteEventMember } = await import('./event-memberships.js');
    return this.store.transaction(async (tx) =>
      inviteEventMember(
        tx,
        this.namespace,
        owner,
        await this.account(tx, owner),
        eventId,
        target,
      ),
    );
  }
  async revokeEventMember(owner: string, eventId: string, userId: string) {
    const { revokeEventMember } = await import('./event-memberships.js');
    return this.store.transaction(async (tx) =>
      revokeEventMember(
        tx,
        this.namespace,
        owner,
        await this.account(tx, owner),
        eventId,
        userId,
      ),
    );
  }
  async commitMemberPhoto(
    owner: string,
    actor: string,
    grantId: string,
    photo: import('../library.js').LibraryRecord,
  ) {
    const { commitMemberPhoto } = await import('./event-memberships.js');
    return this.store.transaction(async (tx) =>
      commitMemberPhoto(
        tx,
        this.namespace,
        owner,
        await this.account(tx, owner),
        actor,
        grantId,
        photo,
      ),
    );
  }
  async eventPolicy(owner: string) {
    const { organizerEventPolicy } = await import('./event-entitlements.js');
    return this.store.transaction(async (tx) => {
      await this.account(tx, owner);
      return organizerEventPolicy(
        tx,
        this.namespace,
        owner,
        this.roleCatalogEnabled,
      );
    });
  }
  async saveOrganizerEvent(
    owner: string,
    id: string,
    patch: import('./event-entitlements.js').EventPatch,
    create = false,
    maxStoredEvents = 1000,
  ) {
    const { saveOrganizerEvent } = await import('./event-entitlements.js');
    return this.store.transaction(async (tx) => {
      const account = await this.account(tx, owner);
      return saveOrganizerEvent(
        tx,
        this.namespace,
        owner,
        account,
        id,
        patch,
        create,
        maxStoredEvents,
      );
    });
  }
  private assertCatalogOpen(plan: PlanId) {
    if (!isLegacyPlan(plan) && !this.roleCatalogEnabled)
      throw new ApiError(
        503,
        'BILLING_DISABLED',
        'The new plan catalog is not activated. No payment has been started.',
      );
  }
  async organizerEntitlement(owner: string) {
    return this.store.transaction(async (tx) => {
      await this.account(tx, owner);
      const grants = await materializeAllowanceWindows(
        tx,
        this.namespace,
        owner,
      );
      const active = grants.filter(
        (grant) =>
          grantScope(grant) === 'organizer' &&
          !grant.parentGrantId &&
          Boolean(grant.entitlementMonths) &&
          !grant.held &&
          grant.refundFraction < 1 &&
          Date.parse(grant.createdAt) <= Date.now() &&
          Date.parse(grant.expiresAt) > Date.now(),
      );
      const grant = active.sort(
        (a, b) => (b.retentionDays ?? 0) - (a.retentionDays ?? 0),
      )[0];
      return grant
        ? {
            plan: grant.plan,
            retentionDays: grant.retentionDays!,
            liveEvents: grant.liveEvents!,
            paidThrough: grant.expiresAt,
          }
        : null;
    });
  }
  async retentionDays(owner: string, scope: BillingScope = 'legacy') {
    return this.store.transaction(async (tx) => {
      await this.account(tx, owner);
      const grants = (
        await materializeAllowanceWindows(tx, this.namespace, owner)
      ).filter((grant) => scopeAllows(grant, scope));
      if (scope !== 'legacy') {
        const active = grants.filter(
          (grant) =>
            !grant.parentGrantId &&
            !grant.held &&
            grant.refundFraction < 1 &&
            Date.parse(grant.createdAt) <= Date.now() &&
            Date.parse(grant.expiresAt) > Date.now(),
        );
        if (
          scope === 'organizer' &&
          !active.some((grant) => grantScope(grant) === 'organizer')
        )
          throw new ApiError(
            402,
            'ORGANIZER_PLAN_REQUIRED',
            'An active organizer plan is required for event storage.',
          );
        return Math.max(
          7,
          ...active.map(
            (grant) =>
              grant.retentionDays ?? (grant.plan === 'preview' ? 7 : 30),
          ),
        );
      }
      return grants.some(
        (g) =>
          g.plan !== 'preview' &&
          !g.held &&
          g.refundFraction < 1 &&
          Date.parse(g.expiresAt) > Date.now(),
      )
        ? 30
        : 7;
    });
  }
  private storageCapacity(grants: Grant[], scope?: BillingScope) {
    return grants
      .filter(
        (g) =>
          !g.held &&
          Date.parse(g.createdAt) <= Date.now() &&
          Date.parse(g.expiresAt) > Date.now() &&
          (!scope || scopeAllows(g, scope)),
      )
      .reduce(
        (sum, g) => sum + Math.floor(g.storageBytes * (1 - g.refundFraction)),
        0,
      );
  }
  private async baseline(
    account: BillingAccount,
    readBytes: () => Promise<number>,
  ) {
    if (account.storedBytes === undefined) {
      const bytes = await readBytes();
      if (!Number.isSafeInteger(bytes) || bytes < 0)
        throw new ApiError(
          503,
          'STORAGE_ACCOUNTING',
          'Stored photo usage could not be reconciled.',
        );
      account.storedBytes = bytes;
    }
    storageUsage(account);
  }
  async reserveStorage(
    owner: string,
    photoId: string,
    bytes: number,
    readBytes: () => Promise<number>,
    scope: BillingScope = 'legacy',
  ) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0)
      throw new Error('Storage bytes must be a positive whole number.');
    return this.store.transaction(async (tx) => {
      const account = await this.account(tx, owner);
      await this.baseline(account, readBytes);
      const key = this.key('storage', photoId);
      const previous = await tx.get<StorageReservation>(key);
      if (previous) {
        if (
          previous.ownerId !== owner ||
          (previous.scope ?? 'legacy') !== scope ||
          previous.bytes !== bytes ||
          previous.status !== 'reserved'
        )
          throw new ApiError(
            409,
            'STORAGE_RESERVATION_CONFLICT',
            'This upload reservation cannot be reused.',
          );
        return;
      }
      const grants = await tx.list<Grant>(this.ownerKey(owner), 'grant');
      account.storedBytesByScope = reserveScopedStorage(
        storageUsage(account),
        grants,
        scope,
        bytes,
      );
      account.storedBytes! += bytes;
      await tx.put(
        this.key('account', owner),
        this.ownerKey(owner),
        'account',
        account,
      );
      await tx.put(key, this.ownerKey(owner), 'event', {
        ownerId: owner,
        photoId,
        scope,
        bytes,
        status: 'reserved',
        createdAt: new Date().toISOString(),
      } satisfies StorageReservation);
    });
  }
  async releaseStorage(
    owner: string,
    photoId: string,
    bytes: number,
    readBytes: () => Promise<number>,
    onlyReserved = false,
  ) {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new Error('Storage bytes must be a nonnegative whole number.');
    await this.store.transaction(async (tx) => {
      const account = await this.account(tx, owner);
      await this.baseline(account, readBytes);
      const key = this.key('storage', photoId);
      const previous = await tx.get<StorageReservation>(key);
      if (previous?.ownerId && previous.ownerId !== owner)
        throw new ApiError(
          404,
          'NOT_FOUND',
          'This storage reservation is not available.',
        );
      if (previous?.status === 'released' || (!previous && onlyReserved))
        return;
      const usage = storageUsage(account),
        scope = previous?.scope ?? 'legacy';
      if (
        !['legacy', 'personal', 'organizer'].includes(scope) ||
        (previous && usage[scope] < previous.bytes)
      )
        throw new ApiError(
          503,
          'STORAGE_ACCOUNTING',
          'This storage release needs reconciliation.',
        );
      usage[scope] = Math.max(0, usage[scope] - (previous?.bytes ?? bytes));
      account.storedBytes = usage.legacy + usage.personal + usage.organizer;
      await tx.put(
        this.key('account', owner),
        this.ownerKey(owner),
        'account',
        account,
      );
      await tx.put(key, this.ownerKey(owner), 'event', {
        ownerId: owner,
        photoId,
        scope,
        bytes: previous?.bytes ?? bytes,
        status: 'released',
        createdAt: previous?.createdAt ?? new Date().toISOString(),
      } satisfies StorageReservation);
    });
  }
  constructor(
    readonly store: BillingStore,
    readonly provider: BillingProvider | undefined,
    readonly products: ProductMap,
    readonly namespace: 'test_mode' | 'live_mode',
    readonly checkoutEnabled: boolean,
    readonly roleCatalogEnabled = false,
    readonly planChangesEnabled = false,
  ) {}
  key(kind: string, id: string) {
    return billingId(this.namespace, kind, id);
  }
  private ownerKey(owner: string) {
    return `${this.namespace}:${owner}`;
  }
  private async account(tx: BillingTransaction, owner: string) {
    const key = this.key('account', owner);
    let account = await tx.get<BillingAccount>(key);
    if (!account) {
      account = {
        ownerId: owner,
        revision: 0,
        createdAt: new Date().toISOString(),
        subscriptions: {},
      };
      const grant = newGrant(
        this.key('preview', owner),
        owner,
        'preview',
        account.createdAt,
      );
      await tx.put(grant.id, this.ownerKey(owner), 'grant', grant);
    }
    // Every account operation writes the same row: concurrent workers conflict at commit.
    account.revision += 1;
    await tx.put(key, this.ownerKey(owner), 'account', account);
    return account;
  }

  private assertPurchasesOpen(account: BillingAccount) {
    if (account.deletionPendingAt)
      throw new ApiError(
        409,
        'ACCOUNT_DELETION_PENDING',
        'Account deletion has started. New purchases are disabled; retry account deletion to finish.',
      );
  }
  private terminal(subscription: SubscriptionSnapshot) {
    return ['cancelled', 'expired', 'failed'].includes(subscription.status);
  }
  private async pendingOrders(tx: BillingTransaction, owner: string) {
    return (await tx.list<BillingOrder>(this.ownerKey(owner), 'order')).filter(
      (order) => !order.fulfilled && !order.closedAt,
    );
  }
  private checkedSubscription(
    expected: SubscriptionSnapshot,
    actual: SubscriptionSnapshot,
    allowProductChange = false,
  ) {
    if (
      actual.id !== expected.id ||
      actual.orderId !== expected.orderId ||
      actual.customerId !== expected.customerId ||
      (!allowProductChange && actual.productId !== expected.productId)
    )
      throw new ApiError(
        503,
        'BILLING_RECONCILIATION_PENDING',
        'The provider returned inconsistent subscription details. No billing change was accepted.',
      );
    return actual;
  }
  private async reconcileOwned(owner: string, resumeHistory = false) {
    const snapshot = await this.store.transaction(async (tx) => ({
      account: await this.account(tx, owner),
      pending: await this.pendingOrders(tx, owner),
    }));
    const subscriptions = Object.values(snapshot.account.subscriptions);
    if (snapshot.pending.length > 20 || subscriptions.length > 50)
      throw new ApiError(
        503,
        'BILLING_RECONCILIATION_PENDING',
        'Billing history needs provider reconciliation before this action.',
      );
    if (
      (snapshot.pending.length && !this.provider?.inspectCheckout) ||
      (subscriptions.length && !this.provider?.readSubscription)
    )
      throw new ApiError(
        503,
        'BILLING_RECONCILIATION_PENDING',
        'Billing verification is temporarily unavailable. Your account has not been deleted.',
      );
    for (const order of snapshot.pending) {
      if (!order.sessionId) continue; // A lost create response must be retried with the original idempotency key.
      const event = await this.provider!.inspectCheckout!(order);
      if (event) {
        const details = event.payment ?? event.subscription;
        if (!details || details.orderId !== order.id)
          throw new ApiError(
            503,
            'BILLING_RECONCILIATION_PENDING',
            'The provider checkout does not match the saved purchase.',
          );
        await this.apply(event);
      }
    }
    for (const sub of subscriptions) {
      const verified = this.checkedSubscription(
        sub,
        await this.provider!.readSubscription!(sub.id),
        true, // apply() verifies the private approval history before accepting it.
      );
      await this.apply({
        id: randomUUID(),
        type: 'subscription.reconciled',
        subscription: verified,
      });
    }
    if (this.provider)
      await reconcilePaymentHistory(
        {
          ownerId: owner,
          ownerKey: this.ownerKey(owner),
          accountKey: this.key('account', owner),
          namespace: this.namespace,
          store: this.store,
          provider: this.provider,
          account: (tx) => this.account(tx, owner),
          apply: (event) => this.apply(event),
        },
        resumeHistory,
      );
  }
  async reconcile(owner: string) {
    return withAccountLock(owner, async () => {
      await this.reconcileOwned(owner);
      return this.summary(owner);
    });
  }
  async cancelSubscription(
    owner: string,
    subscriptionId: string,
    immediately: boolean,
  ) {
    return withAccountLock(owner, async () => {
      const account = await this.store.transaction((tx) =>
        this.account(tx, owner),
      );
      const saved = account.subscriptions[subscriptionId];
      if (!saved)
        throw new ApiError(
          404,
          'NOT_FOUND',
          'This subscription is not available.',
        );
      if (!this.provider?.readSubscription || !this.provider.cancelSubscription)
        throw new ApiError(
          503,
          'CANCELLATION_UNAVAILABLE',
          'Cancellation is temporarily unavailable. Use the billing portal or retry; cancellation has not been confirmed.',
        );
      const cancellationIntent = await beginSubscriptionCancellation(
        this,
        owner,
        subscriptionId,
      );
      const current = this.checkedSubscription(
        saved,
        await this.provider.readSubscription(saved.id),
      );
      const next =
        this.terminal(current) || (!immediately && current.cancelAtPeriodEnd)
          ? current
          : this.checkedSubscription(
              saved,
              await this.provider.cancelSubscription(saved.id, immediately),
            );
      if (
        immediately
          ? !this.terminal(next)
          : !this.terminal(next) && !next.cancelAtPeriodEnd
      )
        throw new ApiError(
          503,
          'CANCELLATION_PENDING',
          'The provider has not confirmed cancellation. Refresh billing status before trying again.',
        );
      await this.apply({
        id: randomUUID(),
        type: 'subscription.cancellation-confirmed',
        subscription: next,
      });
      await finishSubscriptionCancellation(
        this,
        owner,
        subscriptionId,
        cancellationIntent,
      );
      return this.summary(owner);
    });
  }
  async prepareDeletion(owner: string) {
    // Called inside the account deletion lock. Keep a durable fence before removing any user data.
    await this.reconcileOwned(owner, true);
    await this.store.transaction(async (tx) => {
      const account = await this.account(tx, owner);
      if (account.paymentHistory?.status === 'running')
        throw new ApiError(
          409,
          'BILLING_HISTORY_PENDING',
          'Payment history is still being checked. Open Billing and continue checking history before deleting your account.',
        );
      assertCancellationResolved(account);
      if ((await this.pendingOrders(tx, owner)).length)
        throw new ApiError(
          409,
          'CHECKOUT_PENDING',
          'A checkout is unresolved. Open Billing and check payment status before deleting your account.',
        );
      if (
        Object.values(account.subscriptions).some((sub) => !this.terminal(sub))
      )
        throw new ApiError(
          409,
          'SUBSCRIPTION_ACTIVE',
          'Cancel your subscription immediately in Billing, or wait until its scheduled cancellation completes, before deleting your account.',
        );
      account.deletionPendingAt ??= new Date().toISOString();
      await tx.put(
        this.key('account', owner),
        this.ownerKey(owner),
        'account',
        account,
      );
    });
  }

  async summary(owner: string) {
    return this.store.transaction(async (tx) => {
      const account = await this.account(tx, owner);
      const grants = await materializeAllowanceWindows(
        tx,
        this.namespace,
        owner,
      );
      const balances = Object.fromEntries(
        (['personal', 'organizer', 'legacy'] as const).map((scope) => {
          const scoped = grants.filter((grant) => scopeAllows(grant, scope));
          return [
            scope,
            {
              photosRemaining: scoped.reduce(
                (sum, grant) => sum + remaining(grant, 'index'),
                0,
              ),
              searchesRemaining: scoped.reduce(
                (sum, grant) => sum + remaining(grant, 'search'),
                0,
              ),
              deliveryBytesRemaining: scoped.reduce(
                (sum, grant) => sum + remaining(grant, 'delivery'),
                0,
              ),
              storageBytesLimit: this.storageCapacity(scoped),
            },
          ];
        }),
      );
      return {
        environment: this.namespace,
        historyReconciliationAvailable: Boolean(
          this.provider?.listPayments && this.provider.readPayment,
        ),
        paymentHistory: account.paymentHistory
          ? {
              status: account.paymentHistory.status,
              checkedPayments: account.paymentHistory.checkedPayments,
              startedAt: account.paymentHistory.startedAt,
              through: account.paymentHistory.through,
              completedAt: account.paymentHistory.completedAt ?? null,
            }
          : null,
        checkoutAvailable:
          this.checkoutEnabled &&
          Boolean(this.provider) &&
          !account.deletionPendingAt,
        products: Object.keys(this.products).filter(
          (key) =>
            this.roleCatalogEnabled ||
            isLegacyPlan(key.split(':')[0] as PlanId),
        ),
        roleCatalogAvailable: this.roleCatalogEnabled,
        balances,
        portalAvailable: Boolean(account.customerId && this.provider),
        reconciliationAvailable: Boolean(
          this.provider?.inspectCheckout && this.provider.readSubscription,
        ),
        cancellationAvailable: Boolean(
          this.provider?.cancelSubscription && this.provider.readSubscription,
        ),
        deletionPending: Boolean(account.deletionPendingAt),
        pendingCheckouts: (await this.pendingOrders(tx, owner)).map(
          ({ id, plan, currency, createdAt, paymentStatus, checkoutUrl }) => ({
            id,
            plan,
            currency,
            createdAt,
            status: paymentStatus ?? 'unresolved',
            canResume: Boolean(checkoutUrl),
          }),
        ),
        photosRemaining: grants.reduce((n, g) => n + remaining(g, 'index'), 0),
        searchesRemaining: grants.reduce(
          (n, g) => n + remaining(g, 'search'),
          0,
        ),
        deliveryBytesRemaining: grants.reduce(
          (n, g) => n + remaining(g, 'delivery'),
          0,
        ),
        storageBytesUsed: account.storedBytes ?? null,
        storageBytesUsedByScope: account.storedBytesByScope ?? null,
        storageBytesLimit: this.storageCapacity(grants),
        subscriptions: Object.values(account.subscriptions).map(
          ({ id, status, nextBillingAt, cancelAtPeriodEnd }) => ({
            id,
            status,
            nextBillingAt,
            cancelAtPeriodEnd,
            cancellationPending: Boolean(
              account.pendingSubscriptionCancellations?.[id],
            ),
          }),
        ),
        grants: grants.map(
          ({
            id,
            plan,
            createdAt,
            expiresAt,
            held,
            refundFraction,
            usedPhotos,
            usedSearches,
            ...g
          }) => ({
            id,
            plan,
            scope: grantScope({ plan, ...(g.scope ? { scope: g.scope } : {}) }),
            parentGrantId: g.parentGrantId ?? null,
            entitlementMonths: g.entitlementMonths ?? null,
            createdAt,
            expiresAt,
            held,
            refundFraction,
            usedPhotos,
            usedSearches,
            photosRemaining: remaining(
              {
                ...g,
                id,
                plan,
                createdAt,
                expiresAt,
                held,
                refundFraction,
                usedPhotos,
                usedSearches,
              },
              'index',
            ),
          }),
        ),
      };
    });
  }
  async checkout(
    user: AuthUser,
    requestId: string,
    plan: PlanId,
    currency: Currency,
  ) {
    return withAccountLock(user.id, () =>
      this.startCheckout(user, requestId, plan, currency),
    );
  }
  private async startCheckout(
    user: AuthUser,
    requestId: string,
    plan: PlanId,
    currency: Currency,
  ) {
    this.assertCatalogOpen(plan);
    if (!this.checkoutEnabled || !this.provider)
      throw new ApiError(
        503,
        'BILLING_DISABLED',
        'Checkout is not activated. No payment has been started.',
      );
    if (!user.emailVerified)
      throw new ApiError(
        403,
        'EMAIL_NOT_VERIFIED',
        'Verify your email before starting a purchase.',
      );
    const productId = this.products[`${plan}:${currency}`];
    if (!productId)
      throw new ApiError(
        409,
        'PLAN_UNAVAILABLE',
        'This plan is not available in the selected currency.',
      );
    const id = this.key('order', `${user.id}:${requestId}`);
    const order = await this.store.transaction(async (tx) => {
      const account = await this.account(tx, user.id);
      this.assertPurchasesOpen(account);
      if (
        isSubscriptionPlan(plan) &&
        Object.values(account.subscriptions).some((sub) => !this.terminal(sub))
      )
        throw new ApiError(
          409,
          'SUBSCRIPTION_EXISTS',
          'Manage your existing subscription in Billing, or add a one-time photo pack.',
        );
      const existing = await tx.get<BillingOrder>(id);
      if (existing) {
        if (
          existing.ownerId !== user.id ||
          existing.plan !== plan ||
          existing.currency !== currency
        )
          throw new ApiError(
            409,
            'CHECKOUT_CONFLICT',
            'This checkout attempt already belongs to a different selection.',
          );
        if (existing.fulfilled)
          throw new ApiError(
            409,
            'CHECKOUT_PAID',
            'This purchase has already completed. Refresh your balance.',
          );
        if (existing.closedAt)
          throw new ApiError(
            409,
            'CHECKOUT_CLOSED',
            'This checkout is closed. Start a new purchase.',
          );
        return existing;
      }
      const pending = await this.pendingOrders(tx, user.id);
      if (pending.length) {
        if (
          pending.length === 1 &&
          pending[0]!.plan === plan &&
          pending[0]!.currency === currency
        )
          return pending[0]!;
        throw new ApiError(
          409,
          'CHECKOUT_PENDING',
          'Resume or check your saved checkout in Billing before starting a different purchase.',
        );
      }
      const row: BillingOrder = {
        id,
        ownerId: user.id,
        plan,
        currency,
        productId,
        createdAt: new Date().toISOString(),
        ...(account.customerId ? { customerId: account.customerId } : {}),
      };
      await tx.put(id, this.ownerKey(user.id), 'order', row);
      return row;
    });
    return this.openOrder(order, user);
  }
  private async openOrder(order: BillingOrder, user: AuthUser) {
    if (order.checkoutUrl) return { url: order.checkoutUrl };
    const result = await this.provider!.checkout(order, user);
    await this.store.transaction(async (tx) => {
      await this.account(tx, user.id);
      const current = await tx.get<BillingOrder>(order.id);
      if (!current)
        throw new ApiError(
          503,
          'BILLING_STORAGE',
          'Checkout could not be saved. Retry the same purchase.',
        );
      await tx.put(order.id, this.ownerKey(user.id), 'order', {
        ...current,
        sessionId: result.sessionId,
        checkoutUrl: result.url,
      });
    });
    return { url: result.url };
  }
  async resumeCheckout(user: AuthUser, orderId: string) {
    return withAccountLock(user.id, async () => {
      if (!this.checkoutEnabled || !this.provider)
        throw new ApiError(
          503,
          'BILLING_DISABLED',
          'Checkout is not activated. No payment has been started.',
        );
      if (!user.emailVerified)
        throw new ApiError(
          403,
          'EMAIL_NOT_VERIFIED',
          'Verify your email before resuming a purchase.',
        );
      const order = await this.store.transaction(async (tx) => {
        const account = await this.account(tx, user.id);
        this.assertPurchasesOpen(account);
        const saved = await tx.get<BillingOrder>(orderId);
        if (!saved || saved.ownerId !== user.id)
          throw new ApiError(
            404,
            'NOT_FOUND',
            'This saved checkout is not available.',
          );
        this.assertCatalogOpen(saved.plan);
        if (saved.fulfilled)
          throw new ApiError(
            409,
            'CHECKOUT_PAID',
            'This purchase has already completed. Refresh your balance.',
          );
        if (saved.closedAt)
          throw new ApiError(
            409,
            'CHECKOUT_CLOSED',
            'This checkout is closed. Refresh billing before starting a new purchase.',
          );
        if (
          isSubscriptionPlan(saved.plan) &&
          Object.values(account.subscriptions).some(
            (sub) => !this.terminal(sub),
          )
        )
          throw new ApiError(
            409,
            'SUBSCRIPTION_EXISTS',
            'A subscription is already connected. Check payment status instead of reopening checkout.',
          );
        return saved;
      });
      return this.openOrder(order, user);
    });
  }
  async portal(owner: string) {
    if (!this.provider)
      throw new ApiError(503, 'BILLING_DISABLED', 'Billing is not configured.');
    const account = await this.store.transaction(async (tx) =>
      this.account(tx, owner),
    );
    if (!account.customerId)
      throw new ApiError(
        409,
        'NO_BILLING_ACCOUNT',
        'You do not have a paid billing account yet.',
      );
    return { url: await this.provider.portal(account.customerId) };
  }
  async apply(event: VerifiedBillingEvent) {
    return this.store.transaction(async (tx) => {
      const eventKey = this.key('event', event.id);
      if (await tx.get(eventKey)) return;
      const snapshot = event.payment ?? event.subscription;
      if (!snapshot?.orderId) return; // A different product in the same merchant account.
      const order = await tx.get<BillingOrder>(snapshot.orderId);
      if (!order)
        throw new ApiError(
          503,
          'ORDER_NOT_READY',
          'The billing order is not available yet.',
        );
      if (
        order.id !== snapshot.orderId ||
        !(
          await tx.list<BillingOrder>(this.ownerKey(order.ownerId), 'order')
        ).some(
          (owned) => owned.id === order.id && owned.ownerId === order.ownerId,
        ) ||
        (order.customerId && order.customerId !== snapshot.customerId)
      )
        throw new ApiError(
          400,
          'BILLING_MISMATCH',
          'The billing event does not match its order.',
        );
      const account = await this.account(tx, order.ownerId);
      if (account.customerId && account.customerId !== snapshot.customerId)
        throw new ApiError(
          400,
          'BILLING_MISMATCH',
          'The billing customer does not match this account.',
        );
      account.customerId = snapshot.customerId;
      const sub = event.subscription ?? event.payment?.subscription;
      if (event.subscription && event.payment)
        throw new ApiError(
          400,
          'BILLING_MISMATCH',
          'A billing observation must contain one authoritative subject.',
        );
      if (sub) {
        if (
          sub.orderId !== order.id ||
          sub.customerId !== snapshot.customerId ||
          Object.values(account.subscriptions).some(
            (saved) => saved.orderId === order.id && saved.id !== sub.id,
          )
        )
          throw new ApiError(
            400,
            'BILLING_MISMATCH',
            'The subscription does not match its saved order.',
          );
        await observeSubscriptionPlan(tx, this.namespace, order, sub);
      } else if (order.productId !== snapshot.productId) {
        throw new ApiError(
          400,
          'BILLING_MISMATCH',
          'The billing product does not match its order.',
        );
      }
      if (sub) {
        const existing = account.subscriptions[sub.id];
        if (
          !existing ||
          Date.parse(sub.observedAt) >= Date.parse(existing.observedAt)
        )
          account.subscriptions[sub.id] = sub;
      }
      const payment = event.payment;
      if (
        payment &&
        !payment.setupOnly &&
        ['failed', 'cancelled'].includes(payment.status) &&
        !order.fulfilled
      ) {
        if (
          order.sessionId &&
          order.sessionId !== payment.sessionId &&
          !payment.subscription
        )
          throw new ApiError(
            400,
            'BILLING_MISMATCH',
            'The checkout session does not match this order.',
          );
        await tx.put(order.id, this.ownerKey(order.ownerId), 'order', {
          ...order,
          closedAt: payment.observedAt,
          paymentStatus: payment.status,
          lastCheckedAt: payment.observedAt,
        });
      }
      if (payment && payment.status === 'succeeded' && !payment.setupOnly) {
        if (
          payment.quantity !== 1 ||
          payment.currency !== order.currency ||
          payment.total <= 0 ||
          isSubscriptionPlan(order.plan) !== Boolean(payment.subscription)
        )
          throw new ApiError(
            400,
            'BILLING_MISMATCH',
            'The paid product does not match this order.',
          );
        if (
          !payment.subscription &&
          order.sessionId &&
          order.sessionId !== payment.sessionId
        )
          throw new ApiError(
            400,
            'BILLING_MISMATCH',
            'The checkout session does not match this order.',
          );
        const grantId = this.key('payment', payment.id);
        const existing = await tx.get<Grant>(grantId);
        const period = payment.subscription
          ? await subscriptionPeriod(
              tx,
              this.namespace,
              order,
              payment.subscription,
              payment.createdAt,
            )
          : { plan: order.plan, productId: order.productId };
        const basis = {
          orderId: order.id,
          productId: payment.productId,
          customerId: payment.customerId,
          currency: payment.currency,
          total: payment.total,
        };
        if (
          period.productId !== payment.productId ||
          !Number.isSafeInteger(payment.total) ||
          !Number.isSafeInteger(payment.refunded) ||
          payment.refunded < 0 ||
          !Number.isFinite(Date.parse(payment.createdAt)) ||
          !Number.isFinite(Date.parse(payment.observedAt)) ||
          (existing &&
            (existing.ownerId !== order.ownerId ||
              existing.paymentId !== payment.id ||
              existing.subscriptionId !== payment.subscription?.id ||
              existing.plan !== period.plan ||
              Date.parse(existing.createdAt) !==
                Date.parse(payment.createdAt) ||
              (existing.paymentBasis &&
                (Object.keys(basis) as (keyof typeof basis)[]).some(
                  (key) => existing.paymentBasis![key] !== basis[key],
                ))))
        )
          throw new ApiError(
            400,
            'BILLING_MISMATCH',
            'The payment no longer matches its original approved allowance.',
          );
        const grant =
          existing ??
          newGrant(grantId, order.ownerId, period.plan, payment.createdAt);
        grant.paymentBasis = basis;
        if (
          !existing ||
          Date.parse(payment.observedAt) >= Date.parse(grant.observedAt)
        ) {
          grant.paymentId = payment.id;
          if (payment.subscription)
            grant.subscriptionId = payment.subscription.id;
          grant.refundFraction = Math.max(
            grant.refundFraction,
            Math.min(1, payment.refunded / payment.total),
          );
          grant.held = payment.held;
          grant.observedAt = payment.observedAt;
        }
        await tx.put(grantId, this.ownerKey(order.ownerId), 'grant', grant);
        await tx.put(order.id, this.ownerKey(order.ownerId), 'order', {
          ...order,
          fulfilled: true,
          customerId: payment.customerId,
        });
      }
      await tx.put(
        this.key('account', order.ownerId),
        this.ownerKey(order.ownerId),
        'account',
        account,
      );
      await tx.put(eventKey, this.ownerKey(order.ownerId), 'event', {
        id: event.id,
        type: event.type,
        at: new Date().toISOString(),
      });
    });
  }
  async reserve(
    owner: string,
    operation: 'index' | 'search' | 'delivery',
    amount = 1,
    attemptId?: string,
    scope: BillingScope = 'legacy',
  ) {
    if (!Number.isSafeInteger(amount) || amount <= 0)
      throw new Error('Usage must be a positive whole number.');
    await this.store.transaction(async (tx) => {
      await this.account(tx, owner);
      const receiptKey =
        operation === 'delivery' && attemptId
          ? this.key('delivery', `${owner}:${attemptId}`)
          : undefined;
      if (receiptKey) {
        const previous = await tx.get<DeliveryReservation>(receiptKey);
        if (previous) {
          if (
            previous.ownerId !== owner ||
            previous.bytes !== amount ||
            (previous.scope ?? 'legacy') !== scope
          )
            throw new ApiError(
              409,
              'DELIVERY_RESERVATION_CONFLICT',
              'This delivery attempt cannot be reused.',
            );
          return;
        }
      }
      const allocations: DeliveryReservation['allocations'] = [];
      const grants = (
        await materializeAllowanceWindows(tx, this.namespace, owner)
      )
        .filter((grant) => scopeAllows(grant, scope))
        .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
      if (
        grants.reduce((sum, grant) => sum + remaining(grant, operation), 0) <
        amount
      )
        throw new ApiError(
          402,
          'ALLOWANCE_EXHAUSTED',
          `Your ${operation === 'index' ? 'photo processing' : operation === 'search' ? 'selfie search' : 'delivery'} allowance is used. Open Billing for your balance. No automatic overage charge was made.`,
        );
      let left = amount;
      for (const grant of grants) {
        const used = Math.min(left, remaining(grant, operation));
        if (!used) continue;
        if (operation === 'index') grant.usedPhotos += used;
        else if (operation === 'search') grant.usedSearches += used;
        else {
          grant.usedDeliveryBytes += used;
          allocations.push({ grantId: grant.id, bytes: used });
        }
        await tx.put(grant.id, this.ownerKey(owner), 'grant', grant);
        left -= used;
        if (!left) break;
      }
      if (receiptKey)
        await tx.put(receiptKey, this.ownerKey(owner), 'event', {
          ownerId: owner,
          scope,
          bytes: amount,
          allocations,
          status: 'reserved',
          createdAt: new Date().toISOString(),
        } satisfies DeliveryReservation);
    });
  }
  async reserveDelivery(
    owner: string,
    attemptId: string,
    bytes: number,
    scope: BillingScope = 'legacy',
  ) {
    if (!attemptId || attemptId.length > 128)
      throw new Error('A bounded delivery attempt ID is required.');
    await this.reserve(owner, 'delivery', bytes, attemptId, scope);
  }
  async refundDelivery(
    owner: string,
    attemptId: string,
    reason: NonNullable<DeliveryReservation['reason']>,
  ) {
    if (!['upstream-http-failure', 'metadata-mismatch'].includes(reason))
      throw new Error('Invalid delivery refund reason.');
    await this.store.transaction(async (tx) => {
      await this.account(tx, owner);
      const key = this.key('delivery', `${owner}:${attemptId}`);
      const receipt = await tx.get<DeliveryReservation>(key);
      if (!receipt || receipt.ownerId !== owner)
        throw new ApiError(
          404,
          'DELIVERY_NOT_FOUND',
          'This delivery attempt is not available.',
        );
      if (receipt.status === 'refunded') return;
      for (const allocation of receipt.allocations) {
        const grant = await tx.get<Grant>(allocation.grantId);
        if (
          !grant ||
          grant.ownerId !== owner ||
          grant.usedDeliveryBytes < allocation.bytes
        )
          throw new ApiError(
            503,
            'DELIVERY_ACCOUNTING',
            'The delivery refund needs reconciliation.',
          );
        grant.usedDeliveryBytes -= allocation.bytes;
        await tx.put(grant.id, this.ownerKey(owner), 'grant', grant);
      }
      await tx.put(key, this.ownerKey(owner), 'event', {
        ...receipt,
        status: 'refunded',
        reason,
        refundedAt: new Date().toISOString(),
      } satisfies DeliveryReservation);
    });
  }
}
