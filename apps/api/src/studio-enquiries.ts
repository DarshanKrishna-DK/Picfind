import { createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { withAccountLock } from './locks.js';
import {
  ENQUIRY_ACTOR,
  ENQUIRY_LIMIT,
  ENQUIRY_HOURLY_LIMIT,
  ENQUIRY_PAGE_SIZE,
  enquiryFormWrite,
  enquirySubmit,
  enquiryUpdate,
  enquiryStage,
  savedEnquiry,
  savedEnquiryForm,
  type Enquiry,
  type EnquiryForm,
} from '../../../packages/shared/src/studio-enquiries.js';

const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function enquiryFormId(owner: string) {
  const value = hash(['picfind:enquiry-form', owner]);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`;
}
const unavailable = () =>
  new ApiError(
    404,
    'ENQUIRY_UNAVAILABLE',
    'This enquiry or form is not available.',
  );
const changed = () =>
  new ApiError(
    409,
    'ENQUIRY_CHANGED',
    'These details changed. Reload the latest version before continuing.',
  );
const invalid = () =>
  new ApiError(
    503,
    'ENQUIRY_METADATA_INVALID',
    'Enquiry metadata needs repair before it can be used.',
  );
function uuid(value: unknown) {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw unavailable();
  return parsed.data;
}
export function readStudioEnquiry(
  row: LibraryRecord,
  ownerId: string,
  id = row.id,
): Enquiry {
  if (
    row.id !== id ||
    row.kind !== 'job' ||
    row.ownerId !== ownerId ||
    row.purpose !== 'studio-enquiry' ||
    row.eventId ||
    row.deletionStartedAt !== undefined ||
    row.deletionCompletedAt !== undefined
  )
    throw unavailable();
  const value = savedEnquiry.safeParse(row.studioEnquiry);
  if (
    !value.success ||
    value.data.id !== id ||
    value.data.createdAt !== row.createdAt ||
    value.data.formId !== enquiryFormId(ownerId)
  )
    throw invalid();
  return value.data;
}
export function createStudioEnquiries(
  getStore: () => LibraryStore,
  owner: (req: Request) => Promise<string>,
) {
  const router = Router();
  const submissions = rateLimit({
    windowMs: 15 * 60_000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  async function actor(req: Request) {
    const id = await owner(req);
    if (req.get(ENQUIRY_ACTOR) && req.get(ENQUIRY_ACTOR) !== id)
      throw new ApiError(
        403,
        'ACCOUNT_CHANGED',
        'The signed-in account changed. Reload the studio.',
      );
    return id;
  }
  async function get(id: string) {
    try {
      return await getStore().get(id);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404) return null;
      throw failure;
    }
  }
  function scope(
    row: LibraryRecord,
    id: string,
    ownerId: string,
    purpose: LibraryRecord['purpose'],
  ) {
    if (
      row.id !== id ||
      row.kind !== 'job' ||
      row.ownerId !== ownerId ||
      row.purpose !== purpose ||
      row.eventId ||
      row.deletionStartedAt !== undefined ||
      row.deletionCompletedAt !== undefined
    )
      throw unavailable();
  }
  function formValue(row: LibraryRecord) {
    scope(row, enquiryFormId(row.ownerId), row.ownerId, 'studio-enquiry-form');
    const value = savedEnquiryForm.safeParse(row.enquiryForm);
    if (
      !value.success ||
      value.data.id !== row.id ||
      value.data.createdAt !== row.createdAt
    )
      throw invalid();
    return value.data;
  }
  async function form(ownerId: string): Promise<EnquiryForm | null> {
    const row = await get(enquiryFormId(ownerId));
    if (!row) return null;
    scope(row, enquiryFormId(ownerId), ownerId, 'studio-enquiry-form');
    return formValue(row);
  }
  async function published(id: string, expectedOwner?: string) {
    const row = await get(id);
    if (!row || (expectedOwner !== undefined && row.ownerId !== expectedOwner))
      throw unavailable();
    const value = formValue(row);
    if (!value.enabled) throw unavailable();
    return { ownerId: row.ownerId, value };
  }
  function enquiryValue(
    row: LibraryRecord,
    ownerId: string,
    id = row.id,
  ): Enquiry {
    return readStudioEnquiry(row, ownerId, id);
  }
  async function owned(id: string, ownerId: string) {
    const row = await get(id);
    return row ? { row, value: enquiryValue(row, ownerId, id) } : null;
  }
  async function all(ownerId: string) {
    const rows = (await getStore().list(ownerId, 'job')).filter(
      (row) => row.ownerId === ownerId && row.purpose === 'studio-enquiry',
    );
    if (rows.length > 500) throw invalid();
    return rows.map((row) => enquiryValue(row, ownerId));
  }
  router.get('/studio/enquiry-form', async (req, res) => {
    const accountId = await actor(req);
    res.json({
      accountId,
      id: enquiryFormId(accountId),
      form: await form(accountId),
    });
  });
  router.put('/studio/enquiry-form', async (req, res) => {
    const accountId = await actor(req),
      parsed = enquiryFormWrite.safeParse(req.body);
    if (!parsed.success)
      throw new ApiError(
        400,
        'INVALID_ENQUIRY_FORM',
        'Enter a studio name, short introduction and current form version.',
      );
    const { version, ...fields } = parsed.data,
      digest = hash(parsed.data);
    const result = await withAccountLock(accountId, async () => {
      const id = enquiryFormId(accountId),
        row = await get(id),
        current = await form(accountId);
      if (
        current?.version === version + 1 &&
        row?.enquiryFormCommandDigest === digest
      )
        return current;
      if ((current?.version ?? 0) !== version) throw changed();
      const now = new Date(
        Math.max(Date.now(), current ? Date.parse(current.updatedAt) : 0),
      ).toISOString();
      const next = savedEnquiryForm.parse({
        ...fields,
        id,
        version: version + 1,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      });
      if (JSON.stringify(await form(accountId)) !== JSON.stringify(current))
        throw changed();
      await getStore().put(
        {
          id,
          ownerId: accountId,
          kind: 'job',
          purpose: 'studio-enquiry-form',
          createdAt: next.createdAt,
          enquiryForm: next,
          enquiryFormCommandDigest: digest,
        },
        !current,
      );
      return next;
    });
    res.json({ accountId, id: result.id, form: result });
  });
  router.get('/public/enquiries/:id', async (req, res) => {
    const id = uuid(req.params.id),
      first = await published(id);
    const latest = await published(id, first.ownerId);
    if (JSON.stringify(first.value) !== JSON.stringify(latest.value))
      throw changed();
    const { name, introduction, version } = latest.value;
    res.json({ id, name, introduction, version });
  });
  router.put(
    '/public/enquiries/:id/:requestId',
    submissions,
    async (req, res) => {
      const id = uuid(req.params.id),
        requestId = uuid(req.params.requestId);
      const input = enquirySubmit.safeParse(req.body);
      if (!input.success)
        throw new ApiError(
          400,
          'INVALID_ENQUIRY',
          'Provide valid contact details, a short session request and consent to share them with the photographer.',
        );
      const initial = await published(id),
        digest = hash(input.data);
      const result = await withAccountLock(initial.ownerId, async () => {
        const fresh = await published(id, initial.ownerId);
        if (fresh.value.version !== input.data.formVersion) throw changed();
        const prior = await owned(requestId, initial.ownerId);
        if (prior) {
          if (prior.row.enquirySubmissionDigest !== digest) throw changed();
          const latest = await published(id, initial.ownerId);
          if (JSON.stringify(latest.value) !== JSON.stringify(fresh.value))
            throw changed();
          return prior.value;
        }
        const retained = await all(initial.ownerId);
        if (retained.length >= ENQUIRY_LIMIT)
          throw new ApiError(
            409,
            'ENQUIRY_LIMIT',
            'This photographer is not accepting more enquiries right now.',
          );
        const recent = retained.filter(
          (row) => Date.parse(row.createdAt) > Date.now() - 60 * 60_000,
        );
        if (recent.length >= ENQUIRY_HOURLY_LIMIT) {
          const retrySeconds = Math.max(
            1,
            Math.min(
              3600,
              Math.ceil(
                (Math.min(...recent.map((row) => Date.parse(row.createdAt))) +
                  60 * 60_000 -
                  Date.now()) /
                  1000,
              ),
            ),
          );
          res.set('Retry-After', String(retrySeconds));
          throw new ApiError(
            429,
            'ENQUIRY_INTAKE_BUSY',
            'This photographer has received many recent enquiries. Please try again later.',
          );
        }
        const now = new Date().toISOString();
        const next = savedEnquiry.parse({
          ...input.data,
          id: requestId,
          formId: id,
          version: 1,
          stage: 'new',
          note: '',
          createdAt: now,
          updatedAt: now,
          history: [{ stage: 'new', at: now }],
        });
        const latest = await published(id, initial.ownerId);
        if (JSON.stringify(latest.value) !== JSON.stringify(fresh.value))
          throw changed();
        await getStore().put(
          {
            id: requestId,
            ownerId: initial.ownerId,
            kind: 'job',
            purpose: 'studio-enquiry',
            createdAt: now,
            studioEnquiry: next,
            enquirySubmissionDigest: digest,
          },
          true,
        );
        return next;
      });
      res.status(201).json({ id: result.id, receivedAt: result.createdAt });
    },
  );
  router.get('/studio/enquiries', async (req, res) => {
    const accountId = await actor(req);
    const input = z
      .object({
        offset: z.coerce.number().int().min(0).max(500).default(0),
        stage: enquiryStage.optional(),
        search: z.string().trim().max(200).default(''),
      })
      .strict()
      .safeParse(req.query);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_ENQUIRY_FILTER',
        'Choose a valid inbox filter and page.',
      );
    const values = await all(accountId);
    const filtered = values
      .filter(
        (row) =>
          (!input.data.stage || row.stage === input.data.stage) &&
          `${row.name} ${row.email} ${row.sessionType}`
            .toLowerCase()
            .includes(input.data.search.toLowerCase()),
      )
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
      );
    res.json({
      accountId,
      limit: ENQUIRY_LIMIT,
      pageSize: ENQUIRY_PAGE_SIZE,
      totalCount: values.length,
      filteredCount: filtered.length,
      offset: input.data.offset,
      enquiries: filtered.slice(
        input.data.offset,
        input.data.offset + ENQUIRY_PAGE_SIZE,
      ),
    });
  });
  router.patch('/studio/enquiries/:id', async (req, res) => {
    const accountId = await actor(req),
      id = uuid(req.params.id),
      input = enquiryUpdate.safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_ENQUIRY_UPDATE',
        'Choose a follow-up stage, a short private note and the current version.',
      );
    const digest = hash(input.data);
    const result = await withAccountLock(accountId, async () => {
      const current = await owned(id, accountId);
      if (!current) throw unavailable();
      if (current.row.enquiryHandoff?.status === 'pending')
        throw new ApiError(
          409,
          'HANDOFF_PENDING',
          'Resume or abandon the pending project handoff before editing this enquiry.',
        );
      if (
        current.value.version === input.data.version + 1 &&
        current.row.enquiryUpdateDigest === digest
      )
        return current.value;
      if (current.value.version !== input.data.version) throw changed();
      const history = [...current.value.history];
      const now = new Date(
        Math.max(Date.now(), Date.parse(current.value.updatedAt)),
      ).toISOString();
      if (current.value.stage !== input.data.stage) {
        if (history.length >= 30)
          throw new ApiError(
            409,
            'ENQUIRY_HISTORY_LIMIT',
            'This enquiry has reached its 30-stage history limit. Existing history was kept.',
          );
        history.push({ stage: input.data.stage, at: now });
      }
      const next = savedEnquiry.parse({
        ...current.value,
        stage: input.data.stage,
        note: input.data.note,
        version: input.data.version + 1,
        updatedAt: now,
        history,
      });
      if (
        JSON.stringify((await owned(id, accountId))?.value) !==
        JSON.stringify(current.value)
      )
        throw changed();
      await getStore().put({
        ...current.row,
        studioEnquiry: next,
        enquiryUpdateDigest: digest,
      });
      return next;
    });
    res.json({ accountId, enquiry: result });
  });
  router.delete('/studio/enquiries/:id', async (req, res) => {
    const accountId = await actor(req),
      id = uuid(req.params.id);
    const input = z
      .object({
        version: z
          .number()
          .int()
          .min(1)
          .max(Number.MAX_SAFE_INTEGER - 1),
      })
      .strict()
      .safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_ENQUIRY_DELETE',
        'Load the current enquiry before removing it.',
      );
    await withAccountLock(accountId, async () => {
      const current = await owned(id, accountId);
      if (!current) return;
      if (current.row.enquiryHandoff?.status === 'pending')
        throw new ApiError(
          409,
          'HANDOFF_PENDING',
          'Resume or abandon the pending project handoff before removing this enquiry.',
        );
      if (current.value.version !== input.data.version) throw changed();
      await getStore().remove(id);
    });
    res.status(204).end();
  });
  return router;
}
