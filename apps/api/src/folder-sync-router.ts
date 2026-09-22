import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError } from './auth.js';
import type { FolderSyncControls } from './folder-sync-controls.js';
import { SOURCE_PROVIDERS } from './source-connections.js';

/** Mounted behind the library origin/session boundary, not a public event route. */
export function createFolderSyncRouter(
  owner: (req: Request) => Promise<string>,
  controls?: FolderSyncControls,
) {
  const router = Router();
  const params = (req: Request) => {
    const parsed = z
      .object({ eventId: z.uuid(), syncId: z.uuid().optional() })
      .strict()
      .safeParse(req.params);
    if (!parsed.success)
      throw new ApiError(
        404,
        'NOT_FOUND',
        'This event source is not available.',
      );
    return parsed.data;
  };
  const ready = () => {
    if (!controls)
      throw new ApiError(
        503,
        'FOLDER_SYNC_UNAVAILABLE',
        'Automatic folder imports are not enabled on this deployment.',
      );
    return controls;
  };
  router.post('/events/:eventId/sources', async (req, res) => {
    const actor = await owner(req),
      { eventId } = params(req);
    if (req.get('X-PicFind-Consent') !== 'folder-sync-v1')
      throw new ApiError(
        400,
        'SYNC_CONSENT_REQUIRED',
        'Confirm that PicFind may keep copying new photos from this folder until the event expires or you stop syncing.',
      );
    const parsed = z
      .object({
        requestId: z.uuid(),
        provider: z.enum(SOURCE_PROVIDERS),
        generation: z.uuid(),
        folderId: z.string().trim().min(1).max(2048),
        replacesSyncId: z.uuid().optional(),
        acceptConnectionChange: z.boolean().optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success)
      throw new ApiError(
        400,
        'INVALID_INPUT',
        'Choose one folder from the connected source.',
      );
    res
      .status(201)
      .json({ source: await ready().create(actor, eventId, parsed.data) });
  });
  router.get('/events/:eventId/sources', async (req, res) => {
    const actor = await owner(req),
      { eventId } = params(req);
    res.json({ sources: await ready().list(actor, eventId) });
  });
  router.post('/events/:eventId/sources/:syncId/resume', async (req, res) => {
    const actor = await owner(req),
      { eventId, syncId } = params(req);
    if (req.get('X-PicFind-Consent') !== 'folder-sync-v1')
      throw new ApiError(
        400,
        'SYNC_CONSENT_REQUIRED',
        'Confirm continued automatic imports from this folder.',
      );
    const parsed = z
      .object({ requestId: z.uuid(), generation: z.uuid() })
      .strict()
      .safeParse(req.body);
    if (!parsed.success)
      throw new ApiError(
        400,
        'INVALID_INPUT',
        'Refresh the source before resuming.',
      );
    res.json({
      source: await ready().resume(
        actor,
        eventId,
        syncId!,
        parsed.data.requestId,
        parsed.data.generation,
      ),
    });
  });
  router.post('/events/:eventId/sources/:syncId/stop', async (req, res) => {
    const actor = await owner(req),
      { eventId, syncId } = params(req);
    if (
      !z
        .object({})
        .strict()
        .safeParse(req.body ?? {}).success
    )
      throw new ApiError(
        400,
        'INVALID_INPUT',
        'This action does not accept source settings.',
      );
    res.json({ source: await ready().stop(actor, eventId, syncId!) });
  });
  return router;
}
