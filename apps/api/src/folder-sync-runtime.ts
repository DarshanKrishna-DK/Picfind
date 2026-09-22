import { ApiError } from './auth.js';
import type { BillingService } from './billing/service.js';
import { FolderSyncControls } from './folder-sync-controls.js';
import { createFolderSyncImportBridge } from './folder-sync-imports.js';
import { createFolderSyncReader } from './folder-sync-reader.js';
import { FolderSyncWorker, type FolderSyncDirectory } from './folder-sync.js';
import type { JobQueue } from './jobs.js';
import type { LibraryStore } from './library.js';
import { startProcessingWorker } from './processing-worker.js';
import type { SourceConnections } from './source-connections.js';

export function folderSyncFlags(env: NodeJS.ProcessEnv) {
  for (const name of ['FOLDER_SYNC_ENABLED', 'FOLDER_SYNC_STORAGE_ENABLED'])
    if (env[name] && env[name] !== 'true' && env[name] !== 'false')
      throw new Error(`${name} must be true or false.`);
  const enabled = env.FOLDER_SYNC_ENABLED === 'true',
    storage = env.FOLDER_SYNC_STORAGE_ENABLED === 'true';
  if (enabled && (!storage || env.CLOUD_IMPORT_WORKER_ENABLED !== 'true'))
    throw new Error(
      'Folder sync requires FOLDER_SYNC_STORAGE_ENABLED and CLOUD_IMPORT_WORKER_ENABLED so imports and cleanup are both available.',
    );
  return { enabled, storage };
}
type SyncBilling = Pick<
  BillingService,
  | 'roleCatalogEnabled'
  | 'authorizeFolderSync'
  | 'createFolderSync'
  | 'resumeFolderSync'
  | 'commitFolderSyncPhoto'
  | 'stageFolderSyncImport'
>;
export function createFolderSyncRuntime(options: {
  queue: JobQueue;
  store: LibraryStore;
  syncs?: FolderSyncDirectory;
  connections?: Pick<SourceConnections, 'access'>;
  billing?: SyncBilling;
  env?: NodeJS.ProcessEnv;
}) {
  const env = options.env ?? process.env;
  const flags = folderSyncFlags(env);
  if (!flags.storage)
    return {
      enabled: false,
      controls: undefined,
      authority: undefined,
      ...startProcessingWorker(),
    };
  const { billing, syncs } = options;
  if (!billing || !syncs)
    throw new Error(
      'Folder sync storage requires durable organizer billing and private source records.',
    );
  if (
    flags.enabled &&
    (!billing.roleCatalogEnabled ||
      !options.connections ||
      !/^[a-f\d]{64}$/i.test(env.SOURCE_COOKIE_KEY ?? ''))
  )
    throw new Error(
      'New folder syncing requires the organizer catalog, persistent cloud connections and a stable SOURCE_COOKIE_KEY.',
    );
  const connections = options.connections ?? {
    access: async () => {
      throw new ApiError(
        503,
        'SOURCE_NOT_CONFIGURED',
        'Persistent cloud connections are unavailable.',
      );
    },
  };
  const controls = new FolderSyncControls(
    syncs,
    options.store,
    {
      authorizeFolderSync: billing.authorizeFolderSync.bind(billing),
      ...(flags.enabled
        ? {
            createFolderSync: billing.createFolderSync.bind(billing),
            resumeFolderSync: billing.resumeFolderSync.bind(billing),
          }
        : {}),
    },
    connections,
    options.queue,
  );
  const authorize = controls.authorize.bind(controls);
  const authority = createFolderSyncImportBridge({
    queue: options.queue,
    store: options.store,
    syncs,
    authorize,
    stage: (sync, root) => billing.stageFolderSyncImport(sync, root),
    publish: (sync, root, photo) =>
      billing.commitFolderSyncPhoto(sync, root, photo),
  });
  const worker = flags.enabled
    ? new FolderSyncWorker(syncs, {
        authorize,
        list: createFolderSyncReader(connections, env.SOURCE_COOKIE_KEY!),
        enqueue: authority.enqueue,
        inspect: authority.inspect,
      })
    : undefined;
  return {
    enabled: flags.enabled,
    controls,
    authority,
    ...startProcessingWorker(worker),
  };
}
