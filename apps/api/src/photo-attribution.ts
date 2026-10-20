import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryStore } from './library.js';
import { withAccountLock } from './locks.js';
import { attributionFields } from '../../../packages/shared/src/photo-attribution.js';
import { CREDIT_ACTOR_HEADER } from '../../../packages/shared/src/credit-presets.js';
import {
  ownedCreditPhoto,
  readPhotoCredit as readCredit,
} from './photo-attribution-access.js';
export function createPhotoAttribution(
  getStore: () => LibraryStore,
  actorOf: (req: Request) => Promise<string>,
) {
  const router = Router();
  async function actor(req: Request) {
    const id = await actorOf(req);
    if (req.get(CREDIT_ACTOR_HEADER) && req.get(CREDIT_ACTOR_HEADER) !== id)
      throw new ApiError(
        403,
        'ACCOUNT_CHANGED',
        'Your signed-in account changed. Reload photographer credits.',
      );
    return id;
  }
  const ownedPhoto = (id: unknown, accountId: string, publishing = false) =>
    ownedCreditPhoto(getStore(), id, accountId, publishing);
  router.get('/photos/:id/attribution', async (req, res) => {
    res.json({
      attribution: readCredit(
        await ownedPhoto(req.params.id, await actor(req)),
      ),
    });
  });
  router.patch('/photos/:id/attribution', async (req, res) => {
    const accountId = await actor(req);
    const input = z
      .object({
        name: z.unknown(),
        website: z.unknown(),
        published: z.unknown(),
        version: z
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER - 2),
      })
      .strict()
      .safeParse(req.body);
    const fields = input.success
      ? attributionFields.safeParse({
          name: input.data.name,
          website: input.data.website,
          published: input.data.published,
        })
      : null;
    if (!input.success || !fields?.success)
      throw new ApiError(
        400,
        'INVALID_ATTRIBUTION',
        'Use a credit name up to 100 characters, an optional HTTPS website without credentials, and the current version. Publishing requires a name.',
      );
    const result = await withAccountLock(accountId, async () => {
      const photo = await ownedPhoto(
        req.params.id,
        accountId,
        fields.data.published,
      );
      const current = readCredit(photo);
      const same =
        current.name === fields.data.name &&
        current.website === fields.data.website &&
        current.published === fields.data.published;
      if (
        same &&
        (current.version === input.data.version ||
          current.version === input.data.version + 1)
      )
        return current;
      if (current.version !== input.data.version)
        throw new ApiError(
          409,
          'ATTRIBUTION_CHANGED',
          'Another edit changed this photographer credit. Load the latest version before saving.',
        );
      const attribution = {
        ...fields.data,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      };
      const fresh = await ownedPhoto(
        req.params.id,
        accountId,
        fields.data.published,
      );
      const latest = readCredit(fresh);
      if (JSON.stringify(latest) !== JSON.stringify(current))
        throw new ApiError(
          409,
          'ATTRIBUTION_CHANGED',
          'Photographer credit changed while saving. Load the latest version.',
        );
      await getStore().put({ ...fresh, attribution });
      return attribution;
    });
    res.json({ attribution: result });
  });
  return router;
}
