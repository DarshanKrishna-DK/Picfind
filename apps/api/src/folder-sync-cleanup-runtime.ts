import { AppwriteFolderSyncStore } from './adapters/appwrite-folder-sync.js';
import { AppwriteJobStore } from './adapters/appwrite-jobs.js';
import { AppwriteLibraryStore } from './adapters/appwrite-library.js';
import type { BillingService } from './billing/service.js';
import { FolderSyncCleanup } from './folder-sync-cleanup.js';
import { FolderSyncCleanupWorker } from './folder-sync-cleanup-worker.js';
import { JobQueue } from './jobs.js';
import { startProcessingWorker } from './processing-worker.js';

/** Must remain enabled while sync records exist, even when new syncing is disabled. */
export function createFolderSyncCleanupRuntime(
  config: {
    APPWRITE_ENDPOINT: string;
    APPWRITE_PROJECT_ID: string;
    APPWRITE_API_KEY: string;
  },
  billing?: BillingService,
  env: NodeJS.ProcessEnv = process.env,
) {
  const flag = env.FOLDER_SYNC_STORAGE_ENABLED;
  if (flag && flag !== 'true' && flag !== 'false')
    throw new Error('FOLDER_SYNC_STORAGE_ENABLED must be true or false.');
  if (flag !== 'true')
    return { cleanup: undefined, ...startProcessingWorker() };
  if (!config.APPWRITE_API_KEY || !billing)
    throw new Error(
      'Folder sync cleanup requires private Appwrite storage and durable billing authority.',
    );
  const connection = {
    endpoint: config.APPWRITE_ENDPOINT,
    projectId: config.APPWRITE_PROJECT_ID,
    apiKey: config.APPWRITE_API_KEY,
  };
  const sources = new AppwriteFolderSyncStore(connection);
  const store = new AppwriteLibraryStore(connection, billing);
  const queue = new JobQueue(
    new AppwriteJobStore({
      ...connection,
      billingNamespace: billing.namespace,
    }),
  );
  const cleanup = new FolderSyncCleanup(sources, store, queue, (owner) =>
    billing.assertAccountDeleting(owner),
  );
  const worker = new FolderSyncCleanupWorker(sources, cleanup);
  const runtime = startProcessingWorker(worker);
  return {
    cleanup,
    ...runtime,
    status: () => {
      const status = runtime.status();
      return {
        ...status,
        error:
          status.error ??
          (worker.status().outcome === 'deferred'
            ? 'SYNC_CLEANUP_DEFERRED'
            : null),
      };
    },
  };
}
