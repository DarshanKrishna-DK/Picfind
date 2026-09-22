import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BillingService } from '../../apps/api/src/billing/service.js';
import {
  billingId,
  type BillingAccount,
  type BillingProvider,
  type Grant,
  type StorageReservation,
} from '../../apps/api/src/billing/model.js';
import type { EventBillingTransaction } from '../../apps/api/src/billing/event-entitlements.js';
import { cloudPhotoId } from '../../apps/api/src/cloud-photo-import.js';
import type { FolderSync } from '../../apps/api/src/folder-sync.js';
import type { LibraryRecord } from '../../apps/api/src/library.js';
import { stableScanId } from '../../apps/api/src/scan-photo-preparation.js';
import { ImportTestBillingStore } from '../helpers/cloud-import-billing-store.js';

function fixture(moderator = false) {
  const store = new ImportTestBillingStore();
  const provider: BillingProvider = {
    checkout: vi.fn(),
    portal: vi.fn(),
    verify: vi.fn(),
  };
  const billing = new BillingService(
    store,
    provider,
    {},
    'test_mode',
    true,
    true,
  );
  const now = new Date().toISOString(),
    expires = new Date(Date.now() + 86400000).toISOString();
  const sync: FolderSync = {
    id: randomUUID(),
    ownerId: 'owner',
    actorId: moderator ? 'moderator' : 'owner',
    ...(moderator ? { membershipGrantId: randomUUID() } : {}),
    eventId: randomUUID(),
    provider: 'drive',
    generation: randomUUID(),
    folderId: 'folder',
    status: 'active',
    createdAt: now,
    nextRunAt: now,
    cursor: null,
    pages: 0,
    imported: 0,
    pending: { requestId: randomUUID(), fileIds: ['file-a'], nextCursor: null },
  };
  const event: LibraryRecord = {
    id: sync.eventId,
    ownerId: 'owner',
    kind: 'event',
    createdAt: now,
    expiresAt: expires,
    members: moderator
      ? [
          {
            userId: 'moderator',
            role: 'moderator',
            grantId: sync.membershipGrantId!,
            addedAt: now,
          },
        ]
      : [],
  };
  const root: LibraryRecord = {
    id: stableScanId(
      'folder-sync-import',
      sync.id + ':' + sync.pending!.requestId,
    ),
    ownerId: 'owner',
    uploadedBy: sync.actorId,
    ...(sync.membershipGrantId
      ? { membershipGrantId: sync.membershipGrantId }
      : {}),
    kind: 'job',
    purpose: 'import',
    processingSource: 'cloud',
    source: sync.provider,
    folderSyncId: sync.id,
    eventId: sync.eventId,
    processingRequestId: sync.pending!.requestId,
    createdAt: now,
  };
  const photo: LibraryRecord = {
    id: cloudPhotoId(root.id, 'file-a'),
    ownerId: 'owner',
    uploadedBy: sync.actorId,
    kind: 'photo',
    importId: root.id,
    folderSyncId: sync.id,
    eventId: sync.eventId,
    source: 'drive',
    sourcePhotoId: stableScanId('cloud-import-source', 'drive:file-a'),
    createdAt: now,
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    storageReservationId: randomUUID(),
    bytes: 100,
    digest: 'synthetic-photo-digest',
  };
  const account: BillingAccount = {
    ownerId: 'owner',
    revision: 1,
    createdAt: now,
    subscriptions: {},
  };
  const grant: Grant = {
    id: randomUUID(),
    ownerId: 'owner',
    plan: 'organizer-starter-monthly',
    scope: 'organizer',
    entitlementMonths: 1,
    paymentId: 'synthetic-payment',
    subscriptionId: 'synthetic-subscription',
    paymentBasis: {
      orderId: 'order',
      productId: 'product',
      customerId: 'customer',
      currency: 'INR',
      total: 100,
    },
    retentionDays: 30,
    liveEvents: 2,
    createdAt: now,
    expiresAt: expires,
    photos: 0,
    searches: 0,
    deliveryBytes: 0,
    storageBytes: 0,
    usedPhotos: 0,
    usedSearches: 0,
    usedDeliveryBytes: 0,
    refundFraction: 0,
    held: false,
    observedAt: now,
  };
  const reservation: StorageReservation = {
    ownerId: 'owner',
    photoId: photo.storageReservationId!,
    scope: 'organizer',
    status: 'reserved',
    bytes: 100,
    createdAt: now,
  };
  store.syncs.set(sync.id, structuredClone(sync));
  store.events.set(event.id, event);
  store.events.set(root.id, root);
  store.events.set(photo.id, {
    ...photo,
    kind: 'job',
    purpose: 'upload-cleanup',
  });
  store.rows.set(billing.key('account', 'owner'), {
    owner: 'test_mode:owner',
    kind: 'account',
    value: account,
  });
  store.rows.set(grant.id, {
    owner: 'test_mode:owner',
    kind: 'grant',
    value: grant,
  });
  store.rows.set(billing.key('storage', photo.storageReservationId!), {
    owner: 'test_mode:owner',
    kind: 'event',
    value: reservation,
  });
  return {
    store,
    billing,
    sync,
    event,
    root,
    photo,
    account,
    grant,
    reservation,
    commit: () => billing.commitFolderSyncPhoto(sync, root, photo),
  };
}

describe('atomic sync publication policy; synthetic transactions', () => {
  it('rejects publication after a deletion suppression has committed', async () => {
    const f = fixture();
    f.store.events.set(f.photo.id, f.photo);
    await f.billing.suppressFolderSyncPhoto(f.photo);
    await expect(f.commit()).rejects.toMatchObject({
      code: 'IMPORT_UNAVAILABLE',
    });
    expect(
      Date.parse(f.store.events.get(f.photo.id)!.expiresAt!),
    ).toBeLessThanOrEqual(Date.now());
  });
  it('cannot recreate a preserved photo through a fresh upload intent', async () => {
    const f = fixture();
    f.sync.pending!.preservedFileIndexes = [0];
    f.store.syncs.set(f.sync.id, structuredClone(f.sync));
    await expect(f.commit()).rejects.toMatchObject({
      code: 'IMPORT_UNAVAILABLE',
    });
    expect(f.store.events.get(f.photo.id)?.kind).toBe('job');
  });
  it('accepts the original preserved photo with its existing reservation', async () => {
    const f = fixture();
    f.sync.pending!.preservedFileIndexes = [0];
    f.store.syncs.set(f.sync.id, structuredClone(f.sync));
    f.store.events.set(f.photo.id, f.photo);
    await expect(f.commit()).resolves.toMatchObject({
      id: f.photo.id,
      storageReservationId: f.photo.storageReservationId,
    });
  });
  it.each([false, true])(
    'publishes a reserved owner/moderator photo and clips event retention (%s)',
    async (moderator) => {
      const f = fixture(moderator);
      expect(await f.commit()).toMatchObject({
        id: f.photo.id,
        kind: 'photo',
        expiresAt: f.event.expiresAt,
      });
      expect(f.store.events.get(f.photo.id)?.kind).toBe('photo');
      expect(f.store.syncs.get(f.sync.id)?.pending?.fileIds).toEqual([
        'file-a',
      ]);
      if (moderator)
        expect(
          f.store.rows.get(billingId('test_mode', 'account', 'moderator')),
        ).toBeDefined();
    },
  );
  it.each(['paused', 'expired', 'attention'] as const)(
    'rejects %s sync at publication',
    async (status) => {
      const f = fixture();
      f.store.syncs.get(f.sync.id)!.status = status;
      await expect(f.commit()).rejects.toMatchObject({
        code: 'IMPORT_UNAVAILABLE',
      });
      expect(f.store.events.get(f.photo.id)?.kind).toBe('job');
    },
  );
  it('rejects changed connection generation despite a valid old snapshot', async () => {
    const f = fixture();
    f.store.syncs.get(f.sync.id)!.generation = randomUUID();
    await expect(f.commit()).rejects.toMatchObject({
      code: 'IMPORT_UNAVAILABLE',
    });
  });
  it('rejects a removed moderator', async () => {
    const f = fixture(true);
    f.event.members = [];
    await expect(f.commit()).rejects.toMatchObject({ status: 404 });
    expect(f.store.events.get(f.photo.id)?.kind).toBe('job');
    expect(
      f.store.rows.has(billingId('test_mode', 'account', 'moderator')),
    ).toBe(false);
  });
  it('rejects an expired event', async () => {
    const f = fixture();
    f.event.expiresAt = new Date(Date.now() - 1000).toISOString();
    await expect(f.commit()).rejects.toMatchObject({
      code: 'EVENT_UNAVAILABLE',
    });
  });
  it('rejects account deletion', async () => {
    const f = fixture();
    f.account.deletionPendingAt = new Date().toISOString();
    await expect(f.commit()).rejects.toMatchObject({
      code: 'IMPORT_UNAVAILABLE',
    });
  });
  it('rejects moderator account deletion', async () => {
    const f = fixture(true);
    f.store.rows.set(billingId('test_mode', 'account', 'moderator'), {
      owner: 'test_mode:moderator',
      kind: 'account',
      value: {
        ...f.account,
        ownerId: 'moderator',
        deletionPendingAt: new Date().toISOString(),
      },
    });
    await expect(f.commit()).rejects.toMatchObject({
      code: 'IMPORT_UNAVAILABLE',
    });
  });
  it('rejects a held organizer entitlement', async () => {
    const f = fixture();
    f.grant.held = true;
    await expect(f.commit()).rejects.toMatchObject({
      code: 'ORGANIZER_REQUIRED',
    });
  });
  it.each(['released', 'personal'] as const)(
    'rejects a %s storage reservation',
    async (change) => {
      const f = fixture();
      if (change === 'released') f.reservation.status = 'released';
      else f.reservation.scope = 'personal';
      await expect(f.commit()).rejects.toMatchObject({
        code: 'IMPORT_UNAVAILABLE',
      });
    },
  );
  it('rejects a replaced upload intent', async () => {
    const f = fixture();
    f.store.events.get(f.photo.id)!.storageReservationId = randomUUID();
    await expect(f.commit()).rejects.toMatchObject({
      code: 'IMPORT_UNAVAILABLE',
    });
  });
  it('rejects a deleted import root', async () => {
    const f = fixture();
    f.store.events.delete(f.root.id);
    await expect(f.commit()).rejects.toMatchObject({
      code: 'IMPORT_UNAVAILABLE',
    });
  });
  it('rolls back account and authority writes when photo publication fails', async () => {
    const f = fixture(true),
      original = f.store.transaction.bind(f.store);
    vi.spyOn(f.store, 'transaction').mockImplementation((work) =>
      original((tx) => {
        (tx as typeof tx & EventBillingTransaction).events.putPhoto =
          async () => {
            throw new Error('write failure');
          };
        return work(tx);
      }),
    );
    await expect(f.commit()).rejects.toThrow('write failure');
    expect(f.store.events.get(f.photo.id)?.kind).toBe('job');
    expect(
      f.store.rows.get(billingId('test_mode', 'account', 'owner'))?.value,
    ).toMatchObject({ revision: 1 });
    expect(
      f.store.rows.has(billingId('test_mode', 'account', 'moderator')),
    ).toBe(false);
  });
});
