import { reserveFaceUsage } from './usage.js';
import {
  eventCreationId,
  type EventPatch,
} from './billing/event-entitlements.js';
import {
  productBillingScope,
  type ProductScope,
} from './billing/product-scope.js';
import { assertEventImportOpen } from './event-import-policy.js';
import type { SelectionStatus } from '../../../packages/shared/src/proofing.js';
import { createCloudImportRouter, importState } from './cloud-import-router.js';
import { createFolderSyncRouter } from './folder-sync-router.js';
import type { FolderSyncControls } from './folder-sync-controls.js';
import type { SourceConnections } from './source-connections.js';
import { createDiscoverProcessingRouter } from './discover-processing.js';
import { discoverState, publicScan } from './discover-state.js';
import { libraryCapacity } from './capacity.js';
import { withAccountLock } from './locks.js';
import { createPhotoIndexer, requiresUncertainRetry } from './face-indexing.js';
import {
  assertIndexProvider,
  assertSearchModel,
  searchIndexVersion,
} from './face-index-compatibility.js';
import { publicJob, type JobQueue } from './jobs.js';
import {
  deletePhotoSafely,
  tolerateMissingFaceOperation,
} from './photo-deletion.js';
import { uncertainFaceIndex } from './face-cleanup-state.js';
import { sealDriveValue, openDriveValue } from './drive-connection.js';
import express, { Router, type Request } from 'express';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type {
  FaceMatchingProvider,
  Scope,
} from '../../../packages/shared/src/ports.js';
import { ApiError, readSession, type AuthOptions } from './auth.js';
import { MAX_INPUT_BYTES, processPhotoBytes, safeFilename } from './images.js';
import {
  downloadDriveFile,
  listDriveImages,
  parseDriveFolderId,
  type DriveCredentials,
} from './drive.js';
import {
  beginDriveAuthorization,
  driveAccessToken,
  driveRefreshCookie,
  driveStateCookie,
  exchangeDriveCode,
  forgetDriveAccess,
  type DriveOAuthConfig,
} from './drive-oauth.js';
import { mapFaceError } from './face-errors.js';
import { createEventTools } from './event-tools.js';
import { createPhotoNotes } from './photo-notes.js';
import { createPhotoAttribution } from './photo-attribution.js';
import { createHighlights } from './highlights.js';
import { createStudioClients } from './studio-clients.js';
import { createStudioProjects } from './studio-projects.js';
import { createStudioMilestones } from './studio-milestones.js';
import { createStudioAppointments } from './studio-appointments.js';
import {
  ATTRIBUTION_HEADER,
  publishedAttribution,
} from '../../../packages/shared/src/photo-attribution.js';
import { createProofingCollections } from './proofing-collections.js';
import { createCollectionInvitations } from './collection-invitations.js';
import { createEventMembershipRouter } from './event-membership-router.js';
import { memberEvents, requireEventAccess } from './event-membership-access.js';
import { PHOTO_PLANS } from '../../../packages/shared/src/plans.js';
import {
  createCloudSources,
  type CloudSourceOptions,
} from './cloud-sources.js';
import { processingUsage } from './processing-budget.js';
import { matchingReadiness } from './matching-readiness.js';
import { createEventReadiness } from './event-readiness.js';
import { uploadMetadata } from './upload-metadata.js';
import type { BillingService } from './billing/service.js';
import {
  assertPhotoAvailable,
  photoAvailable,
  photoExpiry,
} from './retention.js';

export interface LibraryRecord {
  folderSyncId?: string;
  members?: import('../../../packages/shared/src/event-membership.js').EventMembership[];
  membershipGrantId?: string;
  membershipEventOwnerId?: string;
  membershipRevokedAt?: string;
  memberEmail?: string;
  memberName?: string;
  uploadedBy?: string;
  creationFingerprint?: string;
  processingSource?: 'library' | 'cloud';
  importId?: string;
  storageReservationId?: string;
  processingRequestId?: string;
  sourceFingerprint?: string;
  sourcePhotoId?: string;
  processing?: ReturnType<typeof publicJob>;
  deletionCompletedAt?: string;
  id: string;
  ownerId: string;
  kind: 'event' | 'photo' | 'job';
  createdAt: string;
  title?: string;
  folder?: string;
  description?: string;
  date?: string;
  visibility?: 'private' | 'link';
  archived?: boolean;
  deletionStartedAt?: string;
  expiresAt?: string;
  cleanupAfter?: string;
  eventId?: string;
  filename?: string;
  bytes?: number;
  width?: number;
  height?: number;
  digest?: string;
  uploadInputDigest?: string;
  state?: 'running' | 'complete' | 'partial' | 'failed';
  imported?: number;
  errors?: string[];
  source?: string;
  scanId?: string;
  purpose?:
    | 'import'
    | 'discover-scan'
    | 'event-index'
    | 'usage'
    | 'selection'
    | 'proofing-collection'
    | 'collection-invitation'
    | 'proofing-comment'
    | 'proofing-submission'
    | 'retouching-task'
    | 'event-highlights'
    | 'studio-client'
    | 'studio-project'
    | 'studio-milestone'
    | 'studio-appointment'
    | 'event-membership'
    | 'upload-cleanup';
  passcodeHash?: string;
  retouchingTask?: import('../../../packages/shared/src/retouching.js').StoredRetouchingTask;
  brandingName?: string;
  accentColor?: string;
  selectedIds?: string[];
  collectionVersion?: number;
  collectionUpdatedAt?: string;
  submissionPolicy?: import('../../../packages/shared/src/proofing-policy.js').ProofingSubmissionPolicy;
  invitationCollectionId?: string;
  invitationRecipientId?: string;
  invitationEmail?: string;
  invitationRevokedAt?: string;
  proofingDecisions?: {
    photoId: string;
    status: import('../../../packages/shared/src/proofing-decisions.js').ProofingDecision;
  }[];
  proofingDecisionVersion?: number;
  proofingDecisionUpdatedAt?: string;
  proofingRound?: number;
  proofingSubmission?: import('../../../packages/shared/src/proofing-submission.js').StoredProofingSubmission;
  proofingReopenedFrom?: string;
  proofingReopenReason?: string;
  submissionInvitationId?: string;
  commentInvitationId?: string;
  commentPhotoId?: string;
  commentAuthorId?: string;
  commentAuthorRole?: 'client' | 'photographer';
  commentText?: string;
  commentRemovedAt?: string;
  privatePhotoNote?: string;
  attribution?: import('../../../packages/shared/src/photo-attribution.js').StoredAttribution;
  highlights?: import('../../../packages/shared/src/highlights.js').HighlightSet;
  studioClient?: import('../../../packages/shared/src/studio-clients.js').SavedClient;
  appointmentCommandDigest?: string;
  studioAppointment?: import('../../../packages/shared/src/studio-appointments.js').SavedAppointment;
  milestoneCommandDigest?: string;
  projectRemovalStartedAt?: string;
  studioMilestone?: import('../../../packages/shared/src/studio-milestones.js').SavedMilestone;
  studioProject?: import('../../../packages/shared/src/studio-projects.js').SavedProject;
  projectCommandDigest?: string;
  privatePhotoNoteVersion?: number;
  privatePhotoNoteUpdatedAt?: string;
  submittedById?: string;
  selectionMinimum?: number;
  selectionMaximum?: number;
  selectionClosesAt?: string;
  visitorName?: string;
  note?: string;
  reviewStatus?: SelectionStatus;
  reviewNote?: string;
  reviewVersion?: number;
  reviewedAt?: string;
  searches?: number;
  consentPolicyVersion?: string;
  consentAt?: string;
  provider?: string;
  modelVersion?: string;
  faceIds?: string[];
  externalImageId?: string;
  indexState?: 'none' | 'queued' | 'ready' | 'empty' | 'failed';
  matches?: { photoId: string; similarity: number }[];
  indexed?: number;
  faceMap?: Record<string, string>;
}
export interface LibraryStore {
  stageEventImport?(
    actor: string,
    root: LibraryRecord,
    previousRequestId?: string,
  ): Promise<LibraryRecord>;
  suppressSyncPhoto?(photo: LibraryRecord): Promise<void>;
  expired?(before: string, limit: number): Promise<LibraryRecord[]>;
  list(ownerId: string, kind: LibraryRecord['kind']): Promise<LibraryRecord[]>;
  get(id: string): Promise<LibraryRecord>;
  put(record: LibraryRecord, create?: boolean): Promise<void>;
  remove(id: string): Promise<void>;
  upload(id: string, bytes: Uint8Array): Promise<void>;
  file(id: string): Promise<Response>;
  removeFile(id: string): Promise<void>;
}
export interface LibraryOptions {
  folderSyncCleanup?: import('./folder-sync-cleanup.js').FolderSyncCleanup;
  folderSyncControls?: FolderSyncControls;
  faceJobsEnabled?: boolean;
  cloudImportsEnabled?: boolean;
  folderSyncEnabled?: boolean;
  sourceConnections?: SourceConnections;
  jobQueue?: JobQueue;
  billing?: BillingService;
  store?: LibraryStore;
  driveApiKey?: string;
  driveOAuth?: Omit<DriveOAuthConfig, 'webOrigin' | 'secureCookies'>;
  faceMatcher?: FaceMatchingProvider;
  faceProviderName?: 'aws-rekognition';
  faceIndexMax?: number;
  eventIndexMax?: number;
  sources?: CloudSourceOptions;
}
export const MAX_PHOTOS = 20;
const idSchema = z.uuid();
const eventSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    folder: z.string().trim().max(80).default(''),
    description: z.string().trim().max(2000).default(''),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .or(z.literal(''))
      .default(''),
    visibility: z.enum(['private', 'link']).default('private'),
    archived: z.boolean().default(false),
    expiresAt: z.iso.datetime().or(z.literal('')).default(''),
  })
  .strict();
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'Check the supplied fields and try again.',
    );
  return result.data;
}
function id(req: Request) {
  return parse(idSchema, req.params.id);
}
function available(event: LibraryRecord) {
  return (
    event.kind === 'event' &&
    event.visibility === 'link' &&
    !event.archived &&
    !event.deletionStartedAt &&
    (!event.expiresAt || new Date(event.expiresAt).getTime() > Date.now())
  );
}
export function createLibraryRouter(
  auth: AuthOptions,
  options: LibraryOptions,
) {
  const router = Router();
  const limits = libraryCapacity(options);
  const cookie = {
    httpOnly: true,
    secure: auth.secureCookies,
    sameSite: 'lax' as const,
    path: '/',
  };
  const driveOAuth = options.driveOAuth
    ? {
        ...options.driveOAuth,
        webOrigin: auth.webOrigin,
        secureCookies: auth.secureCookies,
      }
    : undefined;
  const serial = withAccountLock;
  const store = () => {
    if (!options.store)
      throw new ApiError(
        503,
        'STORAGE_UNAVAILABLE',
        'Photo storage has not been configured.',
      );
    return options.store;
  };
  async function owner(req: Request) {
    const secret = readSession(
      req,
      auth.secureCookies ? '__Host-picfind_session' : 'picfind_session',
    );
    if (!secret)
      throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in to continue.');
    if (!auth.provider)
      throw new ApiError(
        503,
        'AUTH_UNAVAILABLE',
        'Account access is not configured.',
      );
    return (await auth.provider.getUser(secret)).id;
  }
  function driveConfigured() {
    return Boolean(options.driveApiKey || driveOAuth);
  }
  async function driveCredentials(req: Request): Promise<DriveCredentials> {
    if (driveOAuth && options.sourceConnections)
      return {
        accessToken: (
          await options.sourceConnections.access(await owner(req), 'drive')
        ).accessToken,
      };
    const refresh = readSession(req, driveRefreshCookie(auth.secureCookies));
    if (driveOAuth && refresh)
      return {
        accessToken: await driveAccessToken(
          driveOAuth,
          openDriveValue(driveOAuth, await owner(req), refresh, 'refresh'),
        ),
      };
    if (options.driveApiKey) return { apiKey: options.driveApiKey };
    throw new ApiError(
      driveOAuth ? 401 : 503,
      driveOAuth ? 'DRIVE_NOT_CONNECTED' : 'DRIVE_UNAVAILABLE',
      driveOAuth
        ? 'Connect Google Drive to continue.'
        : 'Google Drive is not configured.',
    );
  }
  async function owned(
    recordId: string,
    ownerId: string,
    kind?: LibraryRecord['kind'],
  ) {
    const row = await store().get(recordId);
    if (row.ownerId !== ownerId || (kind && row.kind !== kind))
      throw new ApiError(404, 'NOT_FOUND', 'This item is not available.');
    return row;
  }
  async function saveEvent(user: string, eventId: string, patch: EventPatch) {
    if (options.billing)
      return options.billing.saveOrganizerEvent(
        user,
        eventId,
        patch,
        false,
        limits.events,
      );
    const row = await owned(eventId, user, 'event');
    if (
      (patch.expiresAt !== undefined && patch.expiresAt !== row.expiresAt) ||
      (patch.archived === false && row.archived) ||
      (patch.visibility === 'link' && row.visibility !== 'link')
    )
      throw new ApiError(
        402,
        'ORGANIZER_PLAN_REQUIRED',
        'An active organizer plan is required to open or extend an event.',
      );
    // Keep privacy/erasure and harmless metadata edits available during a billing
    // outage. Opening, extending and creating events always require accounting.
    const updated = { ...row, ...patch };
    if (updated.passcodeHash === '') delete updated.passcodeHash;
    await store().put(updated);
    return updated;
  }
  async function driveConnected(req: Request) {
    if (driveOAuth && options.sourceConnections) {
      if (
        !readSession(
          req,
          auth.secureCookies ? '__Host-picfind_session' : 'picfind_session',
        )
      )
        return false;
      return (await options.sourceConnections.status(await owner(req), 'drive'))
        .connected;
    }
    const value = readSession(req, driveRefreshCookie(auth.secureCookies));
    if (driveOAuth && value) {
      try {
        openDriveValue(driveOAuth, await owner(req), value, 'refresh');
        return true;
      } catch {
        return false;
      }
    }
    return Boolean(options.driveApiKey);
  }
  const indexPhotoRecord = createPhotoIndexer({
    providerName: options.faceProviderName ?? 'aws-rekognition',
    reserveUsage,
  });
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.vary('Origin');
    const origin = req.get('Origin');
    if (origin && origin !== auth.webOrigin)
      return next(
        new ApiError(
          403,
          'ORIGIN_REJECTED',
          'This request origin is not allowed.',
        ),
      );
    if (origin === auth.webOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') {
      if (!origin)
        return next(
          new ApiError(403, 'ORIGIN_REJECTED', 'A trusted origin is required.'),
        );
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, PATCH, DELETE, OPTIONS',
      );
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, X-File-Name, X-PicFind-Consent',
      );
      return res.sendStatus(204);
    }
    if (!['GET', 'HEAD'].includes(req.method) && origin !== auth.webOrigin)
      return next(
        new ApiError(403, 'ORIGIN_REJECTED', 'A trusted origin is required.'),
      );
    next();
  });
  function requireAccounting() {
    if (limits.production && !options.billing)
      throw new ApiError(
        503,
        'USAGE_ACCOUNTING_UNAVAILABLE',
        'Storage and delivery accounting must be configured before using this production deployment.',
      );
  }
  async function reserveUsage(
    user: string,
    operation: 'index' | 'search',
    context: ProductScope,
  ) {
    return reserveFaceUsage(store(), options.billing, user, operation, context);
  }
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: 240,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
  );
  router.get('/capabilities', async (req, res) =>
    res.json({
      photoLimit: limits.libraryPhotos,
      maxUploadBytes: MAX_INPUT_BYTES,
      storage: Boolean(options.store),
      folderSync: Boolean(
        options.folderSyncEnabled &&
        options.folderSyncControls &&
        options.folderSyncCleanup &&
        options.cloudImportsEnabled,
      ),
      folderSyncManagement: Boolean(options.folderSyncControls),
      cloudImports: Boolean(
        options.cloudImportsEnabled &&
        options.jobQueue &&
        options.sourceConnections,
      ),
      drive: driveConfigured(),
      driveOAuth: Boolean(driveOAuth),
      driveConnected: await driveConnected(req),
      billing: false,
      faceMatching: Boolean(options.faceMatcher),
      faceProvider: options.faceMatcher
        ? (options.faceProviderName ?? 'aws-rekognition')
        : null,
      faceIndexMax: limits.discoverPhotos,
      discoverJobLimit: options.jobQueue
        ? limits.eventPhotos
        : limits.discoverPhotos,
      durableDiscover: Boolean(
        options.jobQueue && options.faceJobsEnabled !== false,
      ),
      eventIndexMax: limits.eventPhotos,
      capacityMode: limits.production ? 'metered' : 'development',
    }),
  );
  router.post(
    '/drive/connect',
    express.json({ limit: '2kb' }),
    async (req, res) => {
      const user = await owner(req);
      if (!driveOAuth)
        throw new ApiError(
          503,
          'DRIVE_OAUTH_UNAVAILABLE',
          'PicFind Drive access needs GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET from a Google Cloud OAuth client.',
        );
      const state = randomBytes(32).toString('base64url');
      const authorizationAttempt = options.sourceConnections
        ? await withAccountLock(user, async () => {
            await owner(req);
            return options.sourceConnections!.beginAuthorization(user, 'drive');
          })
        : undefined;
      res.cookie(
        driveStateCookie(auth.secureCookies),
        sealDriveValue(
          driveOAuth,
          user,
          authorizationAttempt
            ? JSON.stringify({
                state,
                authorizationAttempt,
                returnTo:
                  req.body?.returnTo === '/app/import'
                    ? '/app/import?source=drive'
                    : '/app/discover/new',
              })
            : state,
          'state',
        ),
        {
          ...cookie,
          maxAge: 10 * 60_000,
        },
      );
      res.json({ url: beginDriveAuthorization(driveOAuth, state) });
    },
  );
  router.get('/drive/callback', async (req, res) => {
    let returnTo = '/app/discover/new';
    const returnUrl = (status: string) =>
      `${auth.webOrigin}${returnTo}${returnTo.includes('?') ? '&' : '?'}drive=${status}`;
    res.setHeader('Referrer-Policy', 'no-referrer');
    const saved = readSession(req, driveStateCookie(auth.secureCookies));
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    res.clearCookie(driveStateCookie(auth.secureCookies), cookie);
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!driveOAuth || !saved)
      return res.redirect(`${auth.webOrigin}/app/discover/new?drive=error`);
    try {
      const user = await owner(req);
      let originalState = openDriveValue(driveOAuth, user, saved, 'state');
      let authorizationAttempt: string | undefined;
      let returnToImport = false;
      if (options.sourceConnections) {
        const payload = JSON.parse(originalState) as {
          state?: unknown;
          authorizationAttempt?: unknown;
          returnTo?: unknown;
        };
        if (
          typeof payload.state !== 'string' ||
          typeof payload.authorizationAttempt !== 'string' ||
          !payload.authorizationAttempt
        )
          throw new Error('Invalid Drive authorization attempt');
        originalState = payload.state;
        authorizationAttempt = payload.authorizationAttempt;
        returnToImport = payload.returnTo === '/app/import?source=drive';
      }
      if (
        Buffer.byteLength(originalState) !== Buffer.byteLength(state) ||
        !timingSafeEqual(Buffer.from(originalState), Buffer.from(state))
      )
        throw new Error('Invalid Drive state');
      if (returnToImport) returnTo = '/app/import?source=drive';
      if (!code) throw new Error('Drive authorization was not completed');
      const refresh = await exchangeDriveCode(driveOAuth, code);
      if (options.sourceConnections) {
        await withAccountLock(user, async () => {
          await owner(req);
          await options.sourceConnections!.connect(
            user,
            'drive',
            {
              refreshToken: refresh,
              accessExpiresAt: 0,
            },
            authorizationAttempt,
          );
        });
        res.clearCookie(driveRefreshCookie(auth.secureCookies), cookie);
      } else {
        res.cookie(
          driveRefreshCookie(auth.secureCookies),
          sealDriveValue(driveOAuth, user, refresh, 'refresh'),
          {
            ...cookie,
            maxAge: 180 * 24 * 60 * 60 * 1000,
          },
        );
      }
      res.redirect(returnUrl('connected'));
    } catch {
      res.redirect(returnUrl('error'));
    }
  });
  router.delete('/drive', async (req, res) => {
    const user = await owner(req);
    if (options.sourceConnections)
      await withAccountLock(user, async () => {
        await owner(req);
        await options.sourceConnections!.disconnect(user, 'drive');
      });
    const refresh = readSession(req, driveRefreshCookie(auth.secureCookies));
    if (refresh && driveOAuth) {
      try {
        forgetDriveAccess(openDriveValue(driveOAuth, user, refresh, 'refresh'));
      } catch {
        /* Clear expired or legacy grants as well. */
      }
    }
    res.clearCookie(driveRefreshCookie(auth.secureCookies), cookie);
    res.status(204).end();
  });
  router.get('/plans', (_req, res) =>
    res.json({
      currency: 'INR',
      plans: PHOTO_PLANS,
      status: 'planned',
      checkoutAvailable: false,
      message: limits.production
        ? 'Storage, processing and delivery are governed by server-side allowances.'
        : 'Paid plans are not available yet. The current library is limited to 20 photos.',
    }),
  );
  router.use(
    '/imports/queued',
    createCloudImportRouter({
      enabled: options.cloudImportsEnabled === true,
      ...(options.jobQueue ? { queue: options.jobQueue } : {}),
      ...(options.sourceConnections
        ? { connections: options.sourceConnections }
        : {}),
      store,
      owner,
      limits,
    }),
  );
  router.use(express.json({ limit: '512kb' }));
  router.use(createFolderSyncRouter(owner, options.folderSyncControls));
  router.use(createEventTools(auth, store, owner, saveEvent));
  router.use(createPhotoNotes(store, owner));
  router.use(createPhotoAttribution(store, owner));
  router.use(createHighlights(store, owner, sendPhoto));
  router.use(createStudioClients(store, owner));
  router.use(createStudioProjects(store, owner));
  router.use(createStudioMilestones(store, owner));
  router.use(createStudioAppointments(store, owner));
  router.use(createEventReadiness(options, owner));
  router.use(createProofingCollections(store, owner));
  router.use(createCollectionInvitations(auth, store, owner, sendPhoto));
  router.use(
    createEventMembershipRouter(auth, store, owner, options.billing, limits),
  );
  router.get('/events/entitlement', async (req, res) => {
    const user = await owner(req);
    res.json(
      options.billing
        ? await options.billing.eventPolicy(user)
        : {
            entitlement: null,
            activeEvents: null,
            remainingEvents: 0,
            maximumExpiresAt: null,
            serverNow: new Date().toISOString(),
            canCreate: false,
            catalogAvailable: false,
          },
    );
  });
  router.get('/usage', async (req, res) => {
    res.json(await processingUsage(store(), await owner(req)));
  });
  router.use(
    createCloudSources(
      auth,
      {
        ...options.sources,
        ...(options.sourceConnections
          ? { connections: options.sourceConnections }
          : {}),
      },
      owner,
      async (user, source, ids, eventId, read) =>
        serial(user, async () => {
          if (eventId) await owned(eventId, user, 'event');
          const remaining =
            limits.libraryPhotos -
            (await store().list(user, 'photo')).filter((photo) => !photo.scanId)
              .length;
          if (ids.length > remaining)
            throw new ApiError(
              409,
              'PHOTO_LIMIT',
              `There is room for ${remaining} more photos. Select a smaller batch.`,
            );
          const job: LibraryRecord = {
            id: randomUUID(),
            ownerId: user,
            kind: 'job',
            purpose: 'import',
            source,
            state: 'running',
            imported: 0,
            errors: [],
            createdAt: new Date().toISOString(),
          };
          await store().put(job, true);
          for (const fileId of ids) {
            let bytes: Buffer | undefined;
            try {
              const file = await read(fileId);
              bytes = file.bytes;
              await upload(user, eventId, file.name, bytes);
              job.imported = (job.imported ?? 0) + 1;
            } catch (error) {
              job.errors!.push(
                error instanceof ApiError
                  ? error.message
                  : 'A selected photo could not be imported. Try it again.',
              );
            } finally {
              bytes?.fill(0);
            }
            await store().put(job);
          }
          job.state = job.imported
            ? job.errors!.length
              ? 'partial'
              : 'complete'
            : 'failed';
          await store().put(job);
          return job;
        }),
    ),
  );
  router.get('/library', async (req, res) => {
    const user = await owner(req);
    const [events, photos, jobs] = await Promise.all([
      store().list(user, 'event'),
      store().list(user, 'photo'),
      store().list(user, 'job'),
    ]);
    const libraryPhotos = photos
      .filter(
        (photo) =>
          !photo.scanId && !photo.deletionStartedAt && photoAvailable(photo),
      )
      .map(({ uploadInputDigest, attribution, ...photo }) => {
        void uploadInputDigest;
        const credit = publishedAttribution(attribution);
        return {
          ...photo,
          filename: photo.filename ?? 'photo.jpg',
          ...(credit ? { credit } : {}),
        };
      });
    const imports = jobs.filter(
      (job) => !job.purpose || job.purpose === 'import',
    );
    const scans = jobs.filter(
      (job) => job.purpose === 'discover-scan' && !job.deletionCompletedAt,
    );
    const hasSavedScans = scans.some(
      (scan) => scan.processingSource === 'library',
    );
    let processingJobs: Awaited<ReturnType<JobQueue['list']>> = [];
    const hasSavedImports = imports.some(
      (job) => job.processingSource === 'cloud',
    );
    let processingUnavailable =
      (hasSavedScans || hasSavedImports) && !options.jobQueue;
    if ((hasSavedScans || hasSavedImports) && options.jobQueue) {
      try {
        processingJobs = await options.jobQueue.list(user);
      } catch {
        processingUnavailable = true;
      }
    }
    res.json({
      events: [
        ...events.map(({ passcodeHash, members, ...event }) => ({
          ...event,
          accessRole: 'owner',
          hasPasscode: Boolean(passcodeHash),
          memberCount: members?.length ?? 0,
        })),
        ...(await memberEvents(store(), user, jobs)),
      ],
      photos: libraryPhotos,
      jobs: imports.map((root) => importState(root, photos, processingJobs)),
      scans: scans.map((scan) => {
        const result = publicScan(
          discoverState(scan, photos, processingJobs),
          new Set(
            photos
              .filter((photo) => photoAvailable(photo))
              .map((photo) => photo.id),
          ),
        );
        return processingUnavailable && scan.processingSource === 'library'
          ? {
              ...result,
              state: 'unavailable',
              errors: [
                'Processing status is temporarily unavailable. Your photos remain available; reopen this search when processing reconnects.',
              ],
            }
          : result;
      }),
      photoLimit: limits.libraryPhotos,
      storedPhotoCount: photos.length,
      capacityMode: limits.production ? 'metered' : 'development',
    });
  });
  router.post('/events', async (req, res) => {
    const user = await owner(req);
    const { requestId, ...data } = parse(
      eventSchema.extend({ requestId: z.uuid().optional() }),
      req.body,
    );
    const event = await serial(user, async () => {
      if (!options.billing)
        throw new ApiError(
          402,
          'ORGANIZER_PLAN_REQUIRED',
          'An active organizer plan is required. Personal photo packs do not include event hosting.',
        );
      return options.billing!.saveOrganizerEvent(
        user,
        requestId ? eventCreationId(user, requestId) : randomUUID(),
        data,
        true,
        limits.events,
      );
    });
    res.status(201).json({ event });
  });
  router.patch('/events/:id', async (req, res) => {
    const user = await owner(req);
    const eventId = id(req);
    const data = parse(eventSchema.partial(), req.body);
    const event = await serial(user, async () => {
      const row = await owned(eventId, user, 'event');
      if (row.deletionStartedAt)
        throw new ApiError(
          409,
          'EVENT_DELETING',
          'Deletion has started. Retry deletion to finish removing this event.',
        );
      return saveEvent(
        user,
        eventId,
        Object.fromEntries(
          Object.entries(data).filter(
            ([key, value]) =>
              Object.hasOwn(req.body as object, key) && value !== undefined,
          ),
        ),
      );
    });
    res.json({ event });
  });
  router.delete('/events/:id', async (req, res) => {
    const user = await owner(req);
    const eventId = id(req);
    await serial(user, async () => {
      const event = await owned(eventId, user, 'event');
      await saveEvent(user, eventId, {
        visibility: 'private',
        archived: true,
        deletionStartedAt: event.deletionStartedAt ?? new Date().toISOString(),
      });
      await options.folderSyncCleanup?.stopEvent(user, eventId);
      await options.jobQueue?.eraseEvent(user, eventId);
      const photos = (await store().list(user, 'photo')).filter(
        (photo) => photo.eventId === eventId,
      );
      if (
        !options.folderSyncCleanup &&
        (options.folderSyncControls ||
          photos.some((photo) => photo.folderSyncId))
      )
        throw new ApiError(
          503,
          'SYNC_CLEANUP_PENDING',
          'Source cleanup must be configured before this event can be erased.',
        );
      if (
        photos.some(
          (photo) =>
            photo.provider ||
            photo.faceIds?.length ||
            uncertainFaceIndex(photo),
        ) &&
        !options.faceMatcher
      )
        throw new ApiError(
          503,
          'FACE_DELETION_INCOMPLETE',
          'Reconnect face matching to delete the provider index safely.',
        );
      if (options.faceMatcher) {
        try {
          await tolerateMissingFaceOperation(() =>
            options.faceMatcher!.deleteScope({ kind: 'event', id: eventId }),
          );
        } catch {
          throw new ApiError(
            503,
            'FACE_DELETION_INCOMPLETE',
            'The event is hidden, but its face index could not be deleted. Retry deletion later.',
          );
        }
      }
      for (const photo of photos) {
        await store().removeFile(photo.id);
        await store().remove(photo.id);
      }
      for (const job of (await store().list(user, 'job')).filter(
        (row) => row.eventId === eventId,
      )) {
        if (job.purpose === 'upload-cleanup') await store().removeFile(job.id);
        await store().remove(job.id);
      }
      await options.folderSyncCleanup?.finishEvent(user, eventId);
      await store().remove(eventId);
    });
    res.status(204).end();
  });
  async function upload(
    user: string,
    eventId: string | undefined,
    filename: string,
    input: Buffer,
    scanId?: string,
    actor = user,
  ): Promise<LibraryRecord> {
    requireAccounting();
    const photos = await store().list(user, 'photo');
    const libraryCount = photos.filter((photo) => !photo.scanId).length;
    const scanCount = scanId
      ? photos.filter((photo) => photo.scanId === scanId).length
      : 0;
    const scanLimit = limits.discoverPhotos;
    let destinationEvent: LibraryRecord | undefined;
    let membershipGrant = 'owner';
    if (eventId) {
      const access = await requireEventAccess(store(), eventId, actor, true);
      const event = access.event;
      if (event.ownerId !== user)
        throw new ApiError(404, 'NOT_FOUND', 'This event is not available.');
      membershipGrant = access.grantId;
      if (actor !== user && !options.billing)
        throw new ApiError(
          503,
          'MEMBERSHIPS_UNAVAILABLE',
          'Event collaboration accounting is unavailable.',
        );
      assertEventImportOpen(event);
      destinationEvent = event;
      if (event.deletionStartedAt)
        throw new ApiError(
          409,
          'EVENT_DELETING',
          'Deletion has started for this event.',
        );
      if (event.archived)
        throw new ApiError(
          409,
          'EVENT_ARCHIVED',
          'Restore this event before uploading.',
        );
    }
    if (!input.length || input.length > MAX_INPUT_BYTES)
      throw new ApiError(
        413,
        'FILE_TOO_LARGE',
        'Choose a photo smaller than 8 MB.',
      );
    const inputDigest = createHash('sha256').update(input).digest('hex');
    function sameDestination(photo: LibraryRecord) {
      return (
        photo.ownerId === user &&
        photo.eventId === eventId &&
        photo.scanId === scanId &&
        !photo.deletionStartedAt &&
        !photo.deletionCompletedAt &&
        photoAvailable(photo)
      );
    }
    async function reuse(
      candidate: LibraryRecord,
      field: 'digest' | 'uploadInputDigest',
      value: string,
    ) {
      const current = await store().get(candidate.id);
      if (eventId) {
        const access = await requireEventAccess(store(), eventId, actor, true);
        if (access.event.ownerId !== user)
          throw new ApiError(404, 'NOT_FOUND', 'This event is not available.');
      }
      if (
        current.id !== candidate.id ||
        !sameDestination(current) ||
        current[field] !== value
      )
        throw new ApiError(
          409,
          'UPLOAD_CHANGED',
          'This uploaded photo changed. Refresh the destination before trying again.',
        );
      return current;
    }
    const replay = photos.find(
      (photo) =>
        sameDestination(photo) && photo.uploadInputDigest === inputDigest,
    );
    if (replay) return reuse(replay, 'uploadInputDigest', inputDigest);
    if (
      (limits.production && photos.length >= limits.libraryPhotos) ||
      (!scanId && libraryCount >= limits.libraryPhotos)
    )
      throw new ApiError(
        409,
        'PHOTO_LIMIT',
        `The ${limits.libraryPhotos}-photo storage safety limit has been reached. Delete unused photos or scans before continuing.`,
      );
    if (scanId && scanCount >= scanLimit)
      throw new ApiError(
        409,
        'PHOTO_LIMIT',
        `This search can index at most ${scanLimit} photos.`,
      );
    if (
      eventId &&
      photos.filter(
        (photo) =>
          photo.eventId === eventId && !photo.scanId && photoAvailable(photo),
      ).length >= limits.eventPhotos
    )
      throw new ApiError(
        409,
        'EVENT_PHOTO_LIMIT',
        `This event can hold ${limits.eventPhotos} photos for face processing. Use another event for additional photos.`,
      );
    const output = await processPhotoBytes(input);
    const existing = photos.find(
      (photo) => sameDestination(photo) && photo.digest === output.digest,
    );
    if (existing) return reuse(existing, 'digest', output.digest);
    const billingScope = productBillingScope(
      options.billing,
      destinationEvent ? 'organizer' : 'personal',
    );
    const planExpiresAt = photoExpiry(
      options.billing
        ? await options.billing.retentionDays(user, billingScope)
        : 7,
    );
    const photo: LibraryRecord = {
      id: randomUUID(),
      ownerId: user,
      kind: 'photo',
      createdAt: new Date().toISOString(),
      filename: safeFilename(filename),
      expiresAt:
        destinationEvent?.expiresAt &&
        Date.parse(destinationEvent.expiresAt) < Date.parse(planExpiresAt)
          ? destinationEvent.expiresAt
          : planExpiresAt,
      bytes: output.data.length,
      width: output.info.width,
      height: output.info.height,
      digest: output.digest,
      uploadInputDigest: inputDigest,
      indexState: 'none',
      uploadedBy: actor,
      ...(eventId ? { eventId } : {}),
      ...(scanId ? { scanId } : {}),
    };
    const storedBytes = async () =>
      (await store().list(user, 'photo')).reduce(
        (sum, row) => sum + (row.bytes ?? 0),
        0,
      );
    // A durable intent exists before either billing or object storage can change.
    const cleanup: LibraryRecord = {
      ...photo,
      kind: 'job',
      purpose: 'upload-cleanup',
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    };
    await store().put(cleanup, true);
    try {
      await options.billing?.reserveStorage(
        user,
        photo.id,
        output.data.length,
        storedBytes,
        billingScope,
      );
      await store().upload(photo.id, output.data);
      if (eventId) {
        const current = await owned(eventId, user, 'event');
        assertEventImportOpen(current);
        if (
          current.expiresAt &&
          Date.parse(current.expiresAt) < Date.parse(photo.expiresAt!)
        )
          photo.expiresAt = current.expiresAt;
      }
      if (actor !== user)
        return await options.billing!.commitMemberPhoto(
          user,
          actor,
          membershipGrant,
          photo,
        );
      await store().put(photo);
    } catch (error) {
      try {
        // A metadata commit may have succeeded even though its reply was lost.
        const saved = await store().get(photo.id);
        if (saved.ownerId !== user) throw new Error('Upload owner mismatch');
        if (saved.kind === 'photo' && saved.digest === photo.digest)
          return saved;
        if (saved.kind !== 'job' || saved.purpose !== 'upload-cleanup')
          throw new Error('Upload state needs repair');
        await store().removeFile(photo.id);
        await options.billing?.releaseStorage(
          user,
          photo.id,
          output.data.length,
          storedBytes,
          true,
        );
        await store().remove(photo.id);
      } catch {
        // The durable intent remains discoverable by retention/account cleanup.
        // Never destroy a possibly committed photo when reconciliation is unavailable.
      }
      throw error;
    }
    return photo;
  }
  router.post(
    '/photos',
    express.raw({ type: 'application/octet-stream', limit: MAX_INPUT_BYTES }),
    async (req, res) => {
      const user = await owner(req);
      const expectedActor = req.get('X-PicFind-Upload-Actor');
      if (expectedActor !== undefined && expectedActor !== user)
        throw new ApiError(
          409,
          'UPLOAD_ACCOUNT_CHANGED',
          'The signed-in account changed. Restore the account that prepared this upload queue.',
        );
      const eventId =
        req.query.eventId === undefined
          ? undefined
          : parse(idSchema, req.query.eventId);
      let filename: string;
      try {
        filename = decodeURIComponent(req.get('X-File-Name') ?? 'photo.jpg');
      } catch {
        throw new ApiError(400, 'INVALID_INPUT', 'The filename is invalid.');
      }
      if (!Buffer.isBuffer(req.body))
        throw new ApiError(
          400,
          'INVALID_IMAGE',
          'Send the image as binary data.',
        );
      const storageOwner = eventId
        ? (await requireEventAccess(store(), eventId, user, true)).event.ownerId
        : user;
      const photo = await serial(storageOwner, () =>
        upload(
          storageOwner,
          eventId,
          filename,
          req.body as Buffer,
          undefined,
          user,
        ),
      );
      res.status(201).json({ photo: uploadMetadata(photo) });
    },
  );
  router.delete('/photos/:id', async (req, res) => {
    const user = await owner(req);
    const photoId = id(req);
    const deletion = await serial(user, async () => {
      const photo = await owned(photoId, user, 'photo');
      return deletePhotoSafely(store(), photo, options.faceMatcher);
    });
    if (deletion === 'pending')
      return res.status(202).json({
        deletion,
        message:
          'Photo hidden. Cloud cleanup is pending and will be retried automatically.',
      });
    res.status(204).end();
  });
  async function sendPhoto(
    photo: LibraryRecord,
    req: Request,
    res: express.Response,
    authorize?: () => Promise<void>,
  ) {
    async function creditHeader() {
      const current = await store().get(photo.id);
      if (
        current.id !== photo.id ||
        current.kind !== 'photo' ||
        current.ownerId !== photo.ownerId ||
        current.eventId !== photo.eventId ||
        current.scanId !== photo.scanId ||
        current.digest !== photo.digest ||
        current.bytes !== photo.bytes ||
        current.deletionStartedAt ||
        current.deletionCompletedAt ||
        !photoAvailable(current)
      )
        throw new ApiError(
          404,
          'NOT_FOUND',
          'This photograph is no longer available.',
        );
      if (current.eventId) {
        const event = await owned(current.eventId, current.ownerId, 'event');
        assertEventImportOpen(event);
      }
      await authorize?.();
      const credit = publishedAttribution(current.attribution);
      if (credit)
        res.setHeader(
          ATTRIBUTION_HEADER,
          encodeURIComponent(JSON.stringify(credit)),
        );
    }
    const deliveryAttempt = randomUUID();
    await authorize?.();
    assertPhotoAvailable(photo);
    if (photo.eventId) {
      const event = await owned(photo.eventId, photo.ownerId, 'event');
      assertEventImportOpen(event);
      if (photo.scanId)
        throw new ApiError(
          409,
          'COLLECTION_MISMATCH',
          'This photo has an invalid collection.',
        );
    }
    if (req.method === 'HEAD') {
      await creditHeader();
      res.type('image/jpeg');
      if (photo.bytes !== undefined)
        res.setHeader('Content-Length', photo.bytes);
      res.end();
      return;
    }
    requireAccounting();
    if (options.billing) {
      if (!Number.isSafeInteger(photo.bytes) || !photo.bytes || photo.bytes < 0)
        throw new ApiError(
          503,
          'PHOTO_METADATA_INVALID',
          'This photo needs storage metadata repair before delivery.',
        );
      // Reserve trusted upload-time size before fetching bytes, preventing free egress on denied requests.
      await options.billing.reserveDelivery(
        photo.ownerId,
        deliveryAttempt,
        photo.bytes,
        productBillingScope(
          options.billing,
          photo.eventId ? 'organizer' : 'personal',
        ),
      );
    }
    let file: Response;
    try {
      file = await store().file(photo.id);
    } catch (error) {
      await options.billing?.refundDelivery(
        photo.ownerId,
        deliveryAttempt,
        'upstream-http-failure',
      );
      throw error;
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    if (options.billing && bytes.byteLength !== photo.bytes) {
      await options.billing.refundDelivery(
        photo.ownerId,
        deliveryAttempt,
        'metadata-mismatch',
      );
      throw new ApiError(
        503,
        'PHOTO_SIZE_MISMATCH',
        'Photo storage returned an unexpected file size. Please retry later.',
      );
    }
    await creditHeader();
    res.type('image/jpeg');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.query.download === '1')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="photo.jpg"; filename*=UTF-8''${encodeURIComponent((photo.filename ?? 'photo').replace(/\.[^.]+$/, '') + '.jpg').replace(/'/g, '%27')}`,
      );
    res.send(bytes);
  }
  router.get('/photos/:id/file', async (req, res) => {
    const user = await owner(req);
    const photo = await store().get(id(req));
    if (photo.kind !== 'photo')
      throw new ApiError(404, 'NOT_FOUND', 'This photograph is not available.');
    async function authorizePhoto() {
      if (photo.ownerId === user) return;
      if (!photo.eventId || photo.scanId)
        throw new ApiError(
          404,
          'NOT_FOUND',
          'This photograph is not available.',
        );
      const access = await requireEventAccess(
        store(),
        photo.eventId,
        user,
        true,
      );
      if (access.event.ownerId !== photo.ownerId)
        throw new ApiError(
          404,
          'NOT_FOUND',
          'This photograph is not available.',
        );
    }
    await sendPhoto(photo, req, res, authorizePhoto);
  });
  router.get('/public/events/:id', async (req, res) => {
    const event = await store().get(id(req));
    if (!available(event))
      throw new ApiError(
        404,
        'NOT_FOUND',
        'This event is private, expired, or no longer available.',
      );
    const photos = (await store().list(event.ownerId, 'photo'))
      .filter((row) => row.eventId === event.id && photoAvailable(row))
      .map(
        ({
          id,
          filename,
          width,
          height,
          createdAt,
          bytes,
          expiresAt,
          attribution,
        }) => {
          const credit = publishedAttribution(attribution);
          return {
            id,
            filename,
            width,
            height,
            createdAt,
            bytes: bytes ?? 0,
            ...(expiresAt ? { expiresAt } : {}),
            ...(credit ? { credit } : {}),
          };
        },
      );
    res.json({
      event: {
        id: event.id,
        title: event.title,
        description: event.description,
        date: event.date,
      },
      photos,
    });
  });
  router.get('/public/events/:id/photos/:photoId', async (req, res) => {
    const event = await store().get(id(req));
    if (!available(event))
      throw new ApiError(404, 'NOT_FOUND', 'This event is not available.');
    const photo = await owned(
      parse(idSchema, req.params.photoId),
      event.ownerId,
      'photo',
    );
    if (photo.eventId !== event.id)
      throw new ApiError(404, 'NOT_FOUND', 'This photo is not available.');
    await sendPhoto(photo, req, res, async () => {
      const latest = await store().get(event.id);
      if (
        latest.id !== event.id ||
        latest.ownerId !== event.ownerId ||
        !available(latest)
      )
        throw new ApiError(
          404,
          'NOT_FOUND',
          'This event is no longer available.',
        );
    });
  });
  router.post('/imports/drive', async (req, res) => {
    const user = await owner(req);
    const drive = await driveCredentials(req);
    const data = parse(
      z.object({ url: z.url(), eventId: idSchema.optional() }).strict(),
      req.body,
    );
    const folderId = parseDriveFolderId(data.url);
    const job = await serial(user, async () => {
      if (
        !limits.production &&
        (await store().list(user, 'job')).filter(
          (row) =>
            row.ownerId === user &&
            row.kind === 'job' &&
            (!row.purpose || row.purpose === 'import'),
        ).length >= 20
      )
        throw new ApiError(
          409,
          'JOB_LIMIT',
          'The development import limit has been reached.',
        );
      if (data.eventId) await owned(data.eventId, user, 'event');
      const record: LibraryRecord = {
        id: randomUUID(),
        ownerId: user,
        kind: 'job',
        purpose: 'import',
        state: 'running',
        imported: 0,
        errors: [],
        source: 'Google Drive',
        createdAt: new Date().toISOString(),
      };
      await store().put(record, true);
      try {
        const remaining =
          limits.libraryPhotos -
          (await store().list(user, 'photo')).filter((photo) => !photo.scanId)
            .length;
        if (remaining < 1)
          throw new ApiError(
            409,
            'PHOTO_LIMIT',
            `The ${limits.libraryPhotos}-photo storage safety limit has been reached. Delete unused photos or scans before continuing.`,
          );
        const files = await listDriveImages(drive, folderId, remaining);
        for (const file of files) {
          try {
            if (Number(file.size ?? 0) > MAX_INPUT_BYTES)
              throw new Error('size');
            const bytes = drive
              ? await downloadDriveFile(drive, file.id)
              : Buffer.from(await (await store().file(file.id)).arrayBuffer());
            await upload(user, data.eventId, file.name, bytes);
            record.imported = (record.imported ?? 0) + 1;
          } catch {
            record.errors!.push(`${file.name}: could not import this photo.`);
          }
          await store().put(record);
        }
        record.state = record.errors!.length
          ? record.imported
            ? 'partial'
            : 'failed'
          : 'complete';
      } catch (error) {
        record.state = 'failed';
        record.errors!.push(
          error instanceof ApiError
            ? error.message
            : 'The import could not be completed.',
        );
      }
      await store().put(record);
      return record;
    });
    res.status(201).json({ job });
  });
  router.get('/processing/jobs/:jobId', async (req, res) => {
    const user = await owner(req);
    if (!options.jobQueue)
      throw new ApiError(
        503,
        'PROCESSING_UNAVAILABLE',
        'Background processing is not configured.',
      );
    res.json({
      job: publicJob(
        await options.jobQueue.owned(
          parse(z.string().regex(/^[a-f0-9]{36}$/), req.params.jobId),
          user,
        ),
      ),
    });
  });
  router.post('/processing/jobs/:jobId/cancel', async (req, res) => {
    const user = await owner(req);
    if (!options.jobQueue)
      throw new ApiError(
        503,
        'PROCESSING_UNAVAILABLE',
        'Background processing is not configured.',
      );
    res.json({
      job: publicJob(
        await options.jobQueue.cancel(
          parse(z.string().regex(/^[a-f0-9]{36}$/), req.params.jobId),
          user,
        ),
      ),
    });
  });
  router.get('/events/:id/processing', async (req, res) => {
    const user = await owner(req);
    const eventId = id(req);
    const event = await owned(eventId, user, 'event');
    const photos = (await store().list(user, 'photo')).filter(
      (photo) =>
        photo.eventId === eventId &&
        !photo.scanId &&
        !photo.deletionStartedAt &&
        photoAvailable(photo),
    );
    const jobs = options.jobQueue
      ? await options.jobQueue.list(user, eventId)
      : [];
    const enabled = Boolean(
      options.jobQueue &&
      options.faceMatcher &&
      options.faceJobsEnabled !== false,
    );
    res.json({
      enabled,
      deleting: Boolean(event.deletionStartedAt),
      retryUncertainRequired: photos.some(requiresUncertainRetry),
      readiness: matchingReadiness(event, photos, {
        provider: options.faceMatcher
          ? (options.faceProviderName ?? 'aws-rekognition')
          : null,
        processingAvailable: enabled,
        active: jobs.some(
          (job) => job.status === 'queued' || job.status === 'running',
        ),
      }),
      jobs: jobs.slice(0, 20).map(publicJob),
    });
  });
  router.post('/events/:id/index-faces', async (req, res) => {
    const user = await owner(req);
    if (options.faceJobsEnabled === false)
      throw new ApiError(
        503,
        'JOB_WORKER_UNAVAILABLE',
        'The face-processing worker is disabled. Cloud imports remain available.',
      );
    if (req.get('X-PicFind-Consent') !== 'face-matching-v1')
      throw new ApiError(
        403,
        'CONSENT_REQUIRED',
        'Confirm that you have permission to prepare face search for these photos.',
      );
    const matcher = options.faceMatcher;
    if (!matcher)
      throw new ApiError(
        503,
        'FACE_MATCHING_UNAVAILABLE',
        'Face matching is not configured.',
      );
    const eventId = id(req);
    if (options.jobQueue) {
      const { requestId, retryUncertain } = parse(
        z
          .object({
            requestId: z.uuid(),
            retryUncertain: z.boolean().default(false),
          })
          .strict(),
        req.body,
      );
      const job = await serial(user, async () => {
        const event = await owned(eventId, user, 'event');
        if (event.deletionStartedAt)
          throw new ApiError(
            409,
            'EVENT_DELETING',
            'Deletion has started. Retry deletion to finish removing this event.',
          );
        if (event.archived)
          throw new ApiError(
            409,
            'EVENT_ARCHIVED',
            'Restore this event before processing.',
          );
        const history = await options.jobQueue!.list(user, eventId);
        const existing = history.find((entry) => entry.requestId === requestId);
        if (existing) {
          if (Boolean(existing.retryUncertain) !== retryUncertain)
            throw new ApiError(
              409,
              'JOB_REQUEST_REUSED',
              'Use a new request to change uncertain-processing authorization.',
            );
          // Replay the original snapshot even if its photos changed meanwhile.
          return existing;
        }
        if (
          history.some(
            (entry) => entry.status === 'queued' || entry.status === 'running',
          )
        )
          throw new ApiError(
            409,
            'PROCESSING_ACTIVE',
            'This event already has an active processing job. Wait for it to finish or stop it first.',
          );
        const photos = (await store().list(user, 'photo')).filter(
          (photo) =>
            photo.eventId === eventId && !photo.scanId && photoAvailable(photo),
        );
        if (!photos.length)
          throw new ApiError(
            400,
            'NO_PHOTOS',
            'Upload photos before preparing face search.',
          );
        if (photos.length > limits.eventPhotos)
          throw new ApiError(
            400,
            'PHOTO_LIMIT',
            'This batch exceeds the configured processing safety limit.',
          );
        const retryUncertainPhotoIds = photos
          .filter(requiresUncertainRetry)
          .map((photo) => photo.id);
        if (retryUncertainPhotoIds.length && !retryUncertain)
          throw new ApiError(
            409,
            'RETRY_UNCERTAIN_REQUIRED',
            'A previous provider request may have completed. Confirm that retrying these photos may consume another processing allowance.',
          );
        return options.jobQueue!.enqueue({
          ownerId: user,
          eventId,
          requestId,
          photoIds: photos.map((photo) => photo.id),
          retryUncertain,
          retryUncertainPhotoIds,
          consentPolicyVersion: 'face-matching-v1',
        });
      });
      return res.status(202).json({ job: publicJob(job) });
    }
    if (limits.production)
      throw new ApiError(
        503,
        'JOB_WORKER_UNAVAILABLE',
        'Background processing must be configured for this production deployment.',
      );
    const event = await serial(user, async () => {
      const row = await owned(eventId, user, 'event');
      if (row.deletionStartedAt)
        throw new ApiError(
          409,
          'EVENT_DELETING',
          'Deletion has started. Retry deletion to finish removing this event.',
        );
      const photos = (await store().list(user, 'photo')).filter(
        (photo) => photo.eventId === eventId,
      );
      const consent = `ingest-${eventId.replaceAll('-', '')}`.slice(0, 64);
      let indexed = 0;
      let failed = 0;
      for (const photo of photos) {
        try {
          const updated = await indexPhotoRecord(
            matcher,
            store(),
            photo,
            { kind: 'event', id: eventId },
            consent,
          );
          if (updated.indexState === 'ready') indexed += 1;
        } catch {
          failed += 1;
        }
      }
      return { event: row, indexed, failed, total: photos.length };
    });
    res.json(event);
  });
  router.use(
    createDiscoverProcessingRouter({
      store,
      owner,
      queue: options.faceJobsEnabled === false ? undefined : options.jobQueue,
      matcher: options.faceMatcher,
      limit: limits.eventPhotos,
      production: limits.production,
      accounting: Boolean(options.billing),
    }),
  );
  router.post('/discover/scans', async (req, res) => {
    const user = await owner(req);
    if (options.faceJobsEnabled === false && req.body?.photoIds)
      throw new ApiError(
        503,
        'JOB_WORKER_UNAVAILABLE',
        'The face-processing worker is disabled. Cloud imports remain available.',
      );
    const data = parse(
      z
        .object({
          url: z.url().optional(),
          photoIds: z
            .array(idSchema)
            .min(1)
            .max(limits.discoverPhotos)
            .optional(),
          consent: z.literal(true),
          policyVersion: z.literal('face-matching-v1'),
        })
        .strict(),
      req.body,
    );
    const matcher = options.faceMatcher;
    if (!matcher)
      throw new ApiError(
        503,
        'FACE_MATCHING_UNAVAILABLE',
        'Face matching is not configured.',
      );
    if (Boolean(data.url) === Boolean(data.photoIds))
      throw new ApiError(
        400,
        'INVALID_INPUT',
        'Choose a Drive folder or library photos, not both.',
      );
    const drive = data.url ? await driveCredentials(req) : undefined;
    const folderId = data.url ? parseDriveFolderId(data.url) : undefined;
    const limit = limits.discoverPhotos;
    if ((data.photoIds?.length ?? 0) > limit)
      throw new ApiError(400, 'PHOTO_LIMIT', `Select at most ${limit} photos.`);
    const scan = await serial(user, async () => {
      const record: LibraryRecord = {
        id: randomUUID(),
        ownerId: user,
        kind: 'job',
        purpose: 'discover-scan',
        state: 'running',
        imported: 0,
        indexed: 0,
        errors: [],
        source: data.url ?? 'library',
        consentPolicyVersion: data.policyVersion,
        consentAt: new Date().toISOString(),
        provider: options.faceProviderName ?? 'aws-rekognition',
        faceMap: {},
        createdAt: new Date().toISOString(),
      };
      await store().put(record, true);
      const scope: Scope = { kind: 'scan', id: record.id.replaceAll('-', '') };
      try {
        const files =
          drive && folderId
            ? await listDriveImages(drive, folderId, limit)
            : await Promise.all(
                [...new Set(data.photoIds!)].map(async (photoId) => {
                  const photo = await owned(photoId, user, 'photo');
                  assertPhotoAvailable(photo);
                  if (photo.scanId || photo.eventId)
                    throw new ApiError(
                      400,
                      'INVALID_INPUT',
                      'Choose a personal library photo, not an event photo or another search result.',
                    );
                  return {
                    id: photo.id,
                    name: photo.filename ?? 'photo.jpg',
                    size: String(photo.bytes ?? 0),
                  };
                }),
              );
        await matcher.ensureScope(scope);
        for (const file of files) {
          try {
            if (Number(file.size ?? 0) > MAX_INPUT_BYTES)
              throw new Error('size');
            const bytes = drive
              ? await downloadDriveFile(drive, file.id)
              : Buffer.from(await (await store().file(file.id)).arrayBuffer());
            const photo = await upload(
              user,
              undefined,
              file.name,
              bytes,
              record.id,
            );
            const indexed = await indexPhotoRecord(
              matcher,
              store(),
              photo,
              scope,
              record.id.replaceAll('-', ''),
            );
            record.imported = (record.imported ?? 0) + 1;
            if (indexed.externalImageId)
              record.faceMap![indexed.externalImageId] = indexed.id;
            if (indexed.indexState === 'ready')
              record.indexed = (record.indexed ?? 0) + 1;
          } catch {
            record.errors!.push(`${file.name}: could not index this photo.`);
          }
          await store().put(record);
        }
        const version = (await store().list(user, 'photo')).find(
          (photo) => photo.scanId === record.id && photo.modelVersion,
        )?.modelVersion;
        if (version) record.modelVersion = version;
        record.state = record.indexed
          ? record.errors!.some((item) => item.includes('could not'))
            ? 'partial'
            : 'complete'
          : 'failed';
        if (!record.indexed)
          record.errors!.push('No faces were indexed from this folder.');
      } catch (error) {
        record.state = 'failed';
        record.errors!.push(
          error instanceof ApiError
            ? error.message
            : 'The search index could not be created.',
        );
        await matcher.deleteScope(scope).catch(() => {});
      }
      await store().put(record);
      return record;
    });
    res.status(201).json({ scan: publicScan(scan) });
  });
  router.post(
    '/discover/scans/:id/search',
    express.raw({ type: 'application/octet-stream', limit: MAX_INPUT_BYTES }),
    async (req, res) => {
      const user = await owner(req);
      const matcher = options.faceMatcher;
      if (!matcher)
        throw new ApiError(
          503,
          'FACE_MATCHING_UNAVAILABLE',
          'Face matching is not configured.',
        );
      if (!Buffer.isBuffer(req.body))
        throw new ApiError(
          400,
          'INVALID_IMAGE',
          'Send the reference photo as binary data.',
        );
      const scanId = id(req);
      const result = await serial(user, async () => {
        const saved = await owned(scanId, user, 'job');
        if (saved.deletionStartedAt)
          throw new ApiError(
            410,
            'SCAN_DELETING',
            'This search is being deleted.',
          );
        if (saved.processingSource && !options.jobQueue)
          throw new ApiError(
            503,
            'JOB_WORKER_UNAVAILABLE',
            'Saved processing is temporarily unavailable.',
          );
        const scan = saved.processingSource
          ? discoverState(
              saved,
              await store().list(user, 'photo'),
              await options.jobQueue!.list(user, saved.id),
            )
          : saved;
        if (scan.purpose !== 'discover-scan')
          throw new ApiError(404, 'NOT_FOUND', 'This search is not available.');
        if (scan.consentPolicyVersion !== 'face-matching-v1')
          throw new ApiError(
            403,
            'CONSENT_REQUIRED',
            'Face matching requires explicit consent.',
          );
        if (scan.state !== 'complete' && scan.state !== 'partial')
          throw new ApiError(
            409,
            'SCAN_NOT_READY',
            'This collection is still processing or failed.',
          );
        if (
          !(await store().list(user, 'photo')).some(
            (photo) => photo.scanId === scan.id && photoAvailable(photo),
          )
        )
          throw new ApiError(
            410,
            'SCAN_EXPIRED',
            'This scan no longer has available photos. Start a new scan with a current collection.',
          );
        const indexedPhotos = (await store().list(user, 'photo')).filter(
          (photo) =>
            photo.ownerId === user &&
            photo.scanId === scan.id &&
            !photo.eventId &&
            !photo.deletionStartedAt &&
            photoAvailable(photo) &&
            photo.indexState === 'ready',
        );
        const provider = options.faceProviderName ?? 'aws-rekognition';
        if (scan.provider) assertIndexProvider(scan, provider);
        const expectedModel = searchIndexVersion(indexedPhotos, provider);
        if (scan.modelVersion)
          assertSearchModel(expectedModel, scan.modelVersion);
        const processed = await processPhotoBytes(req.body as Buffer);
        const bytes = new Uint8Array(processed.data);
        try {
          await reserveUsage(user, 'search', 'personal');
          const search = await matcher.search({
            scope: { kind: 'scan', id: scan.id.replaceAll('-', '') },
            bytes,
            consentRecordId: scan.id.replaceAll('-', ''),
          });
          assertSearchModel(expectedModel, search.modelVersion);
          const photos = (await store().list(user, 'photo')).filter(
            (photo) =>
              photo.ownerId === user &&
              photo.scanId === scan.id &&
              !photo.eventId &&
              !photo.deletionStartedAt &&
              photoAvailable(photo) &&
              photo.indexState === 'ready',
          );
          assertSearchModel(
            expectedModel,
            searchIndexVersion(photos, provider),
          );
          scan.matches = rankMatches(
            photos,
            scan.processingSource
              ? Object.fromEntries(
                  photos
                    .filter(
                      (photo) =>
                        photo.externalImageId && photo.indexState === 'ready',
                    )
                    .map((photo) => [photo.externalImageId!, photo.id]),
                )
              : (scan.faceMap ?? {}),
            search.matches,
          );
          scan.modelVersion = search.modelVersion;
          if (!scan.processingSource) await store().put(scan);
          return { scan, limitReached: search.limitReached };
        } catch (error) {
          mapFaceError(error);
        } finally {
          bytes.fill(0);
          processed.data.fill(0);
        }
      });
      res.json({
        scan: publicScan(result.scan),
        matches: result.scan.matches ?? [],
        limitReached: result.limitReached,
      });
    },
  );
  router.get('/discover/scans/:id', async (req, res) => {
    const user = await owner(req);
    const scan = await owned(id(req), user, 'job');
    if (scan.purpose !== 'discover-scan')
      throw new ApiError(404, 'NOT_FOUND', 'This search is not available.');
    const visible = new Set(
      (await store().list(user, 'photo'))
        .filter((photo) => photoAvailable(photo))
        .map((photo) => photo.id),
    );
    const result = publicScan(scan, visible);
    res.json({ scan: result, matches: result.matches });
  });
  router.delete('/discover/scans/:id', async (req, res) => {
    const user = await owner(req);
    const scanId = id(req);
    await serial(user, async () => {
      const scan = await owned(scanId, user, 'job');
      if (scan.purpose !== 'discover-scan')
        throw new ApiError(404, 'NOT_FOUND', 'This search is not available.');
      for (const photo of (await store().list(user, 'photo')).filter(
        (row) => row.scanId === scanId,
      )) {
        await store().removeFile(photo.id);
        await store().remove(photo.id);
      }
      if (!options.faceMatcher && scan.provider)
        throw new ApiError(
          503,
          'FACE_DELETION_INCOMPLETE',
          'Reconnect face matching to delete this search index.',
        );
      if (options.faceMatcher) {
        try {
          await options.faceMatcher.deleteScope({
            kind: 'scan',
            id: scan.id.replaceAll('-', ''),
          });
        } catch {
          throw new ApiError(
            503,
            'FACE_DELETION_INCOMPLETE',
            'Indexed faces could not be deleted. Retry this deletion.',
          );
        }
      }
      await store().remove(scanId);
    });
    res.status(204).end();
  });
  router.post(
    '/public/events/:id/find',
    express.raw({ type: 'application/octet-stream', limit: MAX_INPUT_BYTES }),
    async (req, res) => {
      const matcher = options.faceMatcher;
      if (!matcher)
        throw new ApiError(
          503,
          'FACE_MATCHING_UNAVAILABLE',
          'Face matching is not configured.',
        );
      if (req.get('X-PicFind-Consent') !== 'face-matching-v1')
        throw new ApiError(
          403,
          'CONSENT_REQUIRED',
          'Confirm the face-matching notice before uploading a selfie.',
        );
      if (!Buffer.isBuffer(req.body))
        throw new ApiError(
          400,
          'INVALID_IMAGE',
          'Send the reference photo as binary data.',
        );
      const event = await store().get(id(req));
      if (!available(event))
        throw new ApiError(404, 'NOT_FOUND', 'This event is not available.');
      const photos = (await store().list(event.ownerId, 'photo')).filter(
        (photo) =>
          photo.ownerId === event.ownerId &&
          photo.eventId === event.id &&
          !photo.scanId &&
          !photo.deletionStartedAt &&
          photoAvailable(photo),
      );
      const ready = photos.filter((photo) => photo.indexState === 'ready');
      if (!ready.length)
        throw new ApiError(
          409,
          'EVENT_NOT_READY',
          'This event is still preparing face search, or no faces were found in the photos.',
        );
      const expectedModel = searchIndexVersion(
        ready,
        options.faceProviderName ?? 'aws-rekognition',
      );
      const processed = await processPhotoBytes(req.body as Buffer);
      const bytes = new Uint8Array(processed.data);
      try {
        await reserveUsage(event.ownerId, 'search', 'organizer');
        const search = await matcher.search({
          scope: { kind: 'event', id: event.id },
          bytes,
          consentRecordId: `find${event.id.replaceAll('-', '')}`.slice(0, 64),
        });
        assertSearchModel(expectedModel, search.modelVersion);
        const latestEvent = await store().get(event.id);
        if (
          !available(latestEvent) ||
          latestEvent.ownerId !== event.ownerId ||
          latestEvent.passcodeHash !== event.passcodeHash
        )
          throw new ApiError(404, 'NOT_FOUND', 'This event is not available.');
        const latestPhotos = (
          await store().list(event.ownerId, 'photo')
        ).filter(
          (photo) =>
            photo.ownerId === event.ownerId &&
            photo.eventId === event.id &&
            !photo.scanId &&
            !photo.deletionStartedAt &&
            photoAvailable(photo) &&
            photo.indexState === 'ready',
        );
        assertSearchModel(
          expectedModel,
          searchIndexVersion(
            latestPhotos,
            options.faceProviderName ?? 'aws-rekognition',
          ),
        );
        const faceMap = Object.fromEntries(
          latestPhotos
            .filter((photo) => photo.externalImageId)
            .map((photo) => [photo.externalImageId!, photo.id]),
        );
        res.json({
          matches: rankMatches(latestPhotos, faceMap, search.matches),
          limitReached: search.limitReached,
          provider: options.faceProviderName ?? 'aws-rekognition',
        });
      } catch (error) {
        mapFaceError(error);
      } finally {
        bytes.fill(0);
        processed.data.fill(0);
      }
    },
  );
  return router;
}

function rankMatches(
  photos: LibraryRecord[],
  faceMap: Record<string, string>,
  matches: { externalImageId: string; similarity: number }[],
) {
  const byId = new Map(
    photos
      .filter((photo) => photoAvailable(photo))
      .map((photo) => [photo.id, photo]),
  );
  const ranked: {
    photoId: string;
    filename: string;
    similarity: number;
    width?: number;
    height?: number;
  }[] = [];
  const seen = new Set<string>();
  for (const match of matches.sort((a, b) => b.similarity - a.similarity)) {
    const photoId = faceMap[match.externalImageId];
    if (!photoId || seen.has(photoId)) continue;
    const photo = byId.get(photoId);
    if (!photo) continue;
    seen.add(photoId);
    ranked.push({
      photoId,
      filename: photo.filename ?? 'photo.jpg',
      similarity: Math.round(match.similarity * 10) / 10,
      ...(photo.width !== undefined ? { width: photo.width } : {}),
      ...(photo.height !== undefined ? { height: photo.height } : {}),
    });
  }
  return ranked;
}
