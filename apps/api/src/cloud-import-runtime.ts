import { AppwriteJobStore } from './adapters/appwrite-jobs.js';
import { AppwriteFolderSyncStore } from './adapters/appwrite-folder-sync.js';
import {
  createFolderSyncRuntime,
  folderSyncFlags,
} from './folder-sync-runtime.js';
import { AppwriteLibraryStore } from './adapters/appwrite-library.js';
import type { BillingService } from './billing/service.js';
import { CloudImportWorker } from './cloud-import-worker.js';
import { createCloudPhotoImporter } from './cloud-photo-import.js';
import { JobQueue } from './jobs.js';
import { startProcessingWorker } from './processing-worker.js';
import { sourceConnectionsFromEnvironment } from './source-connection-runtime.js';

export function createCloudImportRuntime(
  config: {
    APPWRITE_ENDPOINT: string;
    APPWRITE_PROJECT_ID: string;
    APPWRITE_API_KEY: string;
  },
  billing?: BillingService,
  env: NodeJS.ProcessEnv = process.env,
) {
  const flags = folderSyncFlags(env);
  const enabled = env.CLOUD_IMPORT_WORKER_ENABLED === 'true';
  if (!enabled && !flags.storage)
    return {
      queue: undefined,
      enabled: false,
      folderSyncEnabled: false,
      folderSyncControls: undefined,
      ...startProcessingWorker(),
    };
  const connections = sourceConnectionsFromEnvironment(env);
  if (!config.APPWRITE_API_KEY || (enabled && !connections))
    throw new Error(
      'Saved cloud imports require Appwrite storage and persistent cloud connections.',
    );
  const connection = {
    endpoint: config.APPWRITE_ENDPOINT,
    projectId: config.APPWRITE_PROJECT_ID,
    apiKey: config.APPWRITE_API_KEY,
  };
  const store = new AppwriteLibraryStore(connection, billing),
    queue = new JobQueue(
      new AppwriteJobStore({
        ...connection,
        ...(billing ? { billingNamespace: billing.namespace } : {}),
      }),
    );
  const sync = createFolderSyncRuntime({
    queue,
    store,
    ...(billing ? { billing } : {}),
    ...(connections ? { connections } : {}),
    ...(flags.storage
      ? { syncs: new AppwriteFolderSyncStore(connection) }
      : {}),
    env,
  });
  const imports = startProcessingWorker(
    enabled
      ? new CloudImportWorker(
          queue,
          store,
          createCloudPhotoImporter(
            store,
            connections!,
            billing,
            undefined,
            undefined,
            sync.authority,
          ),
          sync.authority,
          billing
            ? (owner, actor) => billing.assertImportAccounts(owner, actor)
            : undefined,
        )
      : undefined,
  );
  return {
    queue,
    enabled,
    folderSyncEnabled: sync.enabled,
    folderSyncControls: sync.controls,
    status: () => combineProcessingStatus(imports.status(), sync.status()),
    stop: async () => {
      await sync.stop();
      await imports.stop();
    },
  };
}
type WorkerStatus = ReturnType<
  ReturnType<typeof startProcessingWorker>['status']
>;
export function combineProcessingStatus(
  ...workers: WorkerStatus[]
): WorkerStatus {
  const enabled = workers.filter((worker) => worker.enabled);
  return {
    enabled: enabled.length > 0,
    running: enabled.some((worker) => worker.running),
    lastSuccessAt:
      enabled.length && enabled.every((worker) => worker.lastSuccessAt)
        ? enabled.map((worker) => worker.lastSuccessAt!).sort()[0]!
        : null,
    error: enabled.find((worker) => worker.error)?.error ?? null,
  };
}
