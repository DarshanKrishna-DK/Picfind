import { cloudSourceEnvironment } from './cloud-sources.js';
import { sourceConnectionsFromEnvironment } from './source-connection-runtime.js';
import { loadProjectEnvironment } from './load-environment.js';
import { createApp } from './app.js';
import { environmentSchema } from './config.js';
import { AppwriteAuthenticationProvider } from './adapters/appwrite-auth.js';
import { AppwriteLibraryStore } from './adapters/appwrite-library.js';
import { applyAwsCliCredentials } from './aws-cli-credentials.js';
import { createFaceMatcher } from './face-provider.js';
import { billingFromEnvironment } from './billing/bootstrap.js';
import { startBillingReconciliation } from './billing/worker.js';
import { startRetentionWorker } from './retention.js';
import { createProcessingRuntime } from './processing-runtime.js';
import { createFolderSyncCleanupRuntime } from './folder-sync-cleanup-runtime.js';
import {
  createCloudImportRuntime,
  combineProcessingStatus,
} from './cloud-import-runtime.js';

try {
  loadProjectEnvironment(import.meta.url);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
    console.error('PicFind could not load local environment configuration.');
    process.exit(1);
  }
}
if (!process.env.FACE_PROVIDER) {
  if (process.env.REKOGNITION_ENABLED === 'true') {
    process.env.FACE_PROVIDER =
      process.env.FACE_MATCHING_PROVIDER ?? 'aws-rekognition';
  } else if (process.env.FACE_MATCHING_PROVIDER) {
    process.env.FACE_PROVIDER = process.env.FACE_MATCHING_PROVIDER;
  }
}

const result = environmentSchema.safeParse(process.env);
if (!result.success) {
  console.error('PicFind environment configuration is invalid.');
  for (const issue of result.error.issues) console.error(issue.message);
  process.exit(1);
}
const config = result.data;
const sourceConnections = sourceConnectionsFromEnvironment(process.env);
const billing = billingFromEnvironment(process.env, config.WEB_ORIGIN);
const billingReconciliation = startBillingReconciliation(
  billing,
  process.env.BILLING_RECONCILIATION_ENABLED === 'true',
);
if (config.FACE_PROVIDER === 'aws-rekognition') await applyAwsCliCredentials();
const faceMatcher = await createFaceMatcher(config);
const driveOAuth =
  config.GOOGLE_DRIVE_CLIENT_ID && config.GOOGLE_DRIVE_CLIENT_SECRET
    ? {
        clientId: config.GOOGLE_DRIVE_CLIENT_ID,
        clientSecret: config.GOOGLE_DRIVE_CLIENT_SECRET,
      }
    : undefined;
const provider = config.APPWRITE_API_KEY
  ? new AppwriteAuthenticationProvider({
      endpoint: config.APPWRITE_ENDPOINT,
      projectId: config.APPWRITE_PROJECT_ID,
      apiKey: config.APPWRITE_API_KEY,
    })
  : undefined;
const retention = startRetentionWorker(
  provider
    ? new AppwriteLibraryStore(
        {
          endpoint: config.APPWRITE_ENDPOINT,
          projectId: config.APPWRITE_PROJECT_ID,
          apiKey: config.APPWRITE_API_KEY,
        },
        billing,
      )
    : undefined,
  faceMatcher,
  process.env.RETENTION_WORKER_ENABLED === 'true' ||
    config.NODE_ENV === 'production',
);
const processing = createProcessingRuntime(config, faceMatcher, billing);
const cloudImports = createCloudImportRuntime(config, billing);
const folderSyncCleanup = createFolderSyncCleanupRuntime(config, billing);
const jobQueue = processing.queue ?? cloudImports.queue;
const server = createApp(
  {
    webOrigin: config.WEB_ORIGIN,
    googleEnabled: config.GOOGLE_OAUTH_ENABLED,
    secureCookies:
      config.NODE_ENV === 'production' ||
      config.WEB_ORIGIN.startsWith('https://'),
    ...(provider ? { provider } : {}),
  },
  {
    ...(jobQueue ? { jobQueue } : {}),
    ...(folderSyncCleanup.cleanup
      ? { folderSyncCleanup: folderSyncCleanup.cleanup }
      : {}),
    cloudImportsEnabled: cloudImports.enabled,
    folderSyncEnabled: cloudImports.folderSyncEnabled,
    ...(cloudImports.folderSyncControls
      ? { folderSyncControls: cloudImports.folderSyncControls }
      : {}),
    faceJobsEnabled: Boolean(processing.queue),
    ...(sourceConnections ? { sourceConnections } : {}),
    ...(provider
      ? {
          store: new AppwriteLibraryStore(
            {
              endpoint: config.APPWRITE_ENDPOINT,
              projectId: config.APPWRITE_PROJECT_ID,
              apiKey: config.APPWRITE_API_KEY,
            },
            billing,
          ),
        }
      : {}),
    ...(billing ? { billing } : {}),
    ...(process.env.GOOGLE_DRIVE_API_KEY
      ? { driveApiKey: process.env.GOOGLE_DRIVE_API_KEY }
      : {}),
    ...(driveOAuth ? { driveOAuth } : {}),
    sources: cloudSourceEnvironment(process.env),
    ...(faceMatcher
      ? {
          faceMatcher,
          faceProviderName: 'aws-rekognition' as const,
          faceIndexMax: config.FACE_INDEX_MAX,
        }
      : {}),
  },
  billing,
  {
    retention: retention.status,
    billingReconciliation: billingReconciliation.status,
    processing: () =>
      combineProcessingStatus(
        processing.status(),
        cloudImports.status(),
        folderSyncCleanup.status(),
      ),
    faceRequired:
      config.NODE_ENV === 'production' && config.FACE_PROVIDER !== 'none',
  },
).listen(config.PORT, config.HOST, () =>
  console.info(
    faceMatcher
      ? 'PicFind local API started with AWS Rekognition face matching.'
      : 'PicFind local API started. Face matching is disabled.',
  ),
);
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    server.close(() => {
      void Promise.all([
        retention.stop(),
        processing.stop(),
        cloudImports.stop(),
        folderSyncCleanup.stop(),
        billingReconciliation.stop(),
      ]).finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 30_000).unref();
  });
