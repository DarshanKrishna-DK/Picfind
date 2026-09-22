import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingService } from '../../apps/api/src/billing/service.js';
import { FolderSyncCleanupWorker } from '../../apps/api/src/folder-sync-cleanup-worker.js';
import { createFolderSyncCleanupRuntime } from '../../apps/api/src/folder-sync-cleanup-runtime.js';
import { ImportTestBillingStore } from '../helpers/cloud-import-billing-store.js';

const mocks = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock('../../apps/api/src/processing-worker.js', () => ({
  startProcessingWorker: mocks.start,
}));
const config = {
  APPWRITE_ENDPOINT: 'https://example.test/v1',
  APPWRITE_PROJECT_ID: 'synthetic',
  APPWRITE_API_KEY: 'synthetic',
};
const billing = () =>
  new BillingService(
    new ImportTestBillingStore(),
    { checkout: vi.fn(), portal: vi.fn(), verify: vi.fn() },
    {},
    'test_mode',
    true,
    true,
  );
beforeEach(() => {
  mocks.start.mockReset();
  mocks.start.mockImplementation((worker?: FolderSyncCleanupWorker) => ({
    status: () => ({
      enabled: Boolean(worker),
      running: false,
      lastSuccessAt: null,
      error: null,
    }),
    stop: vi.fn(async () => {
      worker?.stop();
    }),
  }));
});

describe('cleanup runtime wiring, synthetic configuration and no network', () => {
  it('starts no poller until private sync storage is explicitly enabled', () => {
    const runtime = createFolderSyncCleanupRuntime(config, undefined, {});
    expect(runtime.cleanup).toBeUndefined();
    expect(runtime.status().enabled).toBe(false);
    expect(mocks.start).toHaveBeenCalledWith();
  });
  it('rejects misspelled flags instead of silently abandoning cleanup', () => {
    expect(() =>
      createFolderSyncCleanupRuntime(config, billing(), {
        FOLDER_SYNC_STORAGE_ENABLED: 'yes',
      }),
    ).toThrow('must be true or false');
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('requires both persistent storage and account deletion authority', () => {
    expect(() =>
      createFolderSyncCleanupRuntime(config, undefined, {
        FOLDER_SYNC_STORAGE_ENABLED: 'true',
      }),
    ).toThrow('durable billing authority');
    expect(() =>
      createFolderSyncCleanupRuntime(
        { ...config, APPWRITE_API_KEY: '' },
        billing(),
        { FOLDER_SYNC_STORAGE_ENABLED: 'true' },
      ),
    ).toThrow('durable billing authority');
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('constructs the cleanup lifecycle and worker independently of cloud import scheduling', async () => {
    const runtime = createFolderSyncCleanupRuntime(config, billing(), {
      FOLDER_SYNC_STORAGE_ENABLED: 'true',
      CLOUD_IMPORT_WORKER_ENABLED: 'false',
    });
    expect(runtime.cleanup).toBeDefined();
    expect(runtime.status()).toEqual({
      enabled: true,
      running: false,
      lastSuccessAt: null,
      error: null,
    });
    const worker = mocks.start.mock.calls[0]![0] as FolderSyncCleanupWorker;
    expect(worker).toBeInstanceOf(FolderSyncCleanupWorker);
    await runtime.stop();
    expect(await worker.processNext()).toBe(false);
  });
});
