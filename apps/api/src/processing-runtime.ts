import type { FaceMatchingProvider } from '../../../packages/shared/src/ports.js';
import { AppwriteJobStore } from './adapters/appwrite-jobs.js';
import { AppwriteLibraryStore } from './adapters/appwrite-library.js';
import type { BillingService } from './billing/service.js';
import { createPhotoIndexer } from './face-indexing.js';
import { JobQueue } from './jobs.js';
import {
  EventIndexWorker,
  startProcessingWorker,
} from './processing-worker.js';
import { reserveFaceUsage } from './usage.js';
import { createScanPhotoPreparer } from './scan-photo-preparation.js';
import { libraryCapacity } from './capacity.js';

export function createProcessingRuntime(
  config: {
    APPWRITE_ENDPOINT: string;
    APPWRITE_PROJECT_ID: string;
    APPWRITE_API_KEY: string;
    NODE_ENV: string;
    FACE_INDEX_MAX?: number;
  },
  matcher?: FaceMatchingProvider,
  billing?: BillingService,
) {
  if (
    config.NODE_ENV === 'production' &&
    matcher &&
    process.env.JOB_WORKER_ENABLED === 'false'
  )
    throw new Error(
      'Production face indexing requires the durable processing worker.',
    );
  if (
    !config.APPWRITE_API_KEY ||
    !matcher ||
    process.env.JOB_WORKER_ENABLED === 'false'
  )
    return { queue: undefined, ...startProcessingWorker() };
  const connection = {
    endpoint: config.APPWRITE_ENDPOINT,
    projectId: config.APPWRITE_PROJECT_ID,
    apiKey: config.APPWRITE_API_KEY,
  };
  const store = new AppwriteLibraryStore(connection, billing);
  const queue = new JobQueue(
    new AppwriteJobStore({
      ...connection,
      ...(billing ? { billingNamespace: billing.namespace } : {}),
    }),
  );
  const indexer = createPhotoIndexer({
    providerName: 'aws-rekognition',
    reserveUsage: (ownerId, operation, context) =>
      reserveFaceUsage(store, billing, ownerId, operation, context),
  });
  return {
    queue,
    ...startProcessingWorker(
      new EventIndexWorker(
        queue,
        store,
        matcher,
        indexer,
        createScanPhotoPreparer(
          store,
          billing,
          libraryCapacity(
            config.FACE_INDEX_MAX === undefined
              ? {}
              : { faceIndexMax: config.FACE_INDEX_MAX },
            config.NODE_ENV,
          ),
        ),
      ),
    ),
  };
}
