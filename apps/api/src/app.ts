import { withAccountFaceCleanup } from './account-face-cleanup.js';
import express from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { ApiError, createAuthRouter, type AuthOptions } from './auth.js';
import { createLibraryRouter, type LibraryOptions } from './library.js';
import { createAccountRouter } from './account.js';
import { createBillingRouter } from './billing/router.js';
import type { BillingService } from './billing/service.js';
import type { RetentionStatus } from './retention.js';
import type { BillingWorkerStatus } from './billing/worker.js';

export function createApp(
  auth: AuthOptions = {
    webOrigin: 'http://localhost:5173',
    secureCookies: false,
  },
  library: LibraryOptions = {},
  billing?: BillingService,
  operations: {
    retention?: () => RetentionStatus;
    billingReconciliation?: () => BillingWorkerStatus;
    processing?: () => {
      enabled: boolean;
      running: boolean;
      lastSuccessAt: string | null;
      error: string | null;
    };
    faceRequired?: boolean;
  } = {},
) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.use(helmet());
  app.use((_req, res, next) => {
    res.locals.requestId = randomUUID();
    res.setHeader('X-Request-Id', res.locals.requestId as string);
    next();
  });
  app.get('/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ service: 'PicFind', status: 'alive' });
  });
  app.get('/health/ready', (_req, res) => {
    const retention = operations.retention?.();
    const processing = operations.processing?.();
    const ready = Boolean(
      auth.provider &&
      library.store &&
      (!operations.faceRequired || library.faceMatcher) &&
      (!retention?.enabled || (retention.lastSuccessAt && !retention.error)) &&
      (!processing?.enabled || (processing.lastSuccessAt && !processing.error)),
    );
    res.setHeader('Cache-Control', 'no-store');
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not-ready',
      accounts: Boolean(auth.provider),
      storage: Boolean(library.store),
      faceMatching: Boolean(library.faceMatcher),
      retention: retention ?? { enabled: false },
    });
  });
  app.get('/health/billing', (_req, res) => {
    const status = operations.billingReconciliation?.() ?? { enabled: false };
    res.setHeader('Cache-Control', 'no-store');
    res.status('error' in status && status.error ? 503 : 200).json(status);
  });
  app.use('/api/billing', createBillingRouter(auth, billing));
  app.use('/api/auth', express.json({ limit: '8kb' }), createAuthRouter(auth));
  app.use(
    '/api/account',
    createAccountRouter(
      auth,
      withAccountFaceCleanup(library.store, library.faceMatcher),
      {
        beforeCleanup: async (ownerId) => {
          if (!billing && process.env.NODE_ENV === 'production')
            throw new ApiError(
              503,
              'BILLING_RECONCILIATION_PENDING',
              'Billing must be available to verify account deletion. Your data has not been removed.',
            );
          await billing?.prepareDeletion(ownerId);
          await library.sourceConnections?.disconnectOwner(ownerId);
          if (
            !library.folderSyncCleanup &&
            (library.folderSyncControls ||
              (await library.store?.list(ownerId, 'photo'))?.some(
                (photo) => photo.folderSyncId,
              ))
          )
            throw new ApiError(
              503,
              'SYNC_CLEANUP_PENDING',
              'Source cleanup must be configured before this account can be erased.',
            );
          await library.folderSyncCleanup?.stopAccount(ownerId);
          await library.jobQueue?.cancelOwner(ownerId);
        },
        afterCleanup: async (ownerId) => {
          await library.folderSyncCleanup?.finishAccount(ownerId);
          await library.jobQueue?.eraseOwner(ownerId);
          await library.sourceConnections?.removeOwner(ownerId);
        },
      },
    ),
  );
  app.use('/api', createLibraryRouter(auth, library));
  app.use((_req, res) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'This endpoint is not available.',
        requestId: res.locals.requestId as string,
      },
    });
  });
  const errorHandler: import('express').ErrorRequestHandler = (
    error: unknown,
    _req,
    res,
    _next,
  ) => {
    void _next; // Express identifies error middleware by its four-argument signature.
    const bodyError = error as { type?: string } | null;
    const safeError =
      error instanceof ApiError
        ? error
        : bodyError?.type === 'entity.too.large'
          ? new ApiError(413, 'BODY_TOO_LARGE', 'The request is too large.')
          : bodyError?.type === 'entity.parse.failed'
            ? new ApiError(
                400,
                'INVALID_JSON',
                'The request must contain valid JSON.',
              )
            : new ApiError(
                500,
                'INTERNAL_ERROR',
                'The request could not be completed.',
              );
    res.setHeader('Cache-Control', 'no-store');
    res.status(safeError.status).json({
      error: {
        code: safeError.code,
        message: safeError.message,
        requestId: res.locals.requestId,
      },
    });
  };
  app.use(errorHandler);
  return app;
}
