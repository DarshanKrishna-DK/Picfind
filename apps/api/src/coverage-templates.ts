import { createHash, randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError } from './auth.js';
import { withAccountLock } from './locks.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import {
  COVERAGE_TEMPLATE_LIMIT,
  COVERAGE_TEMPLATE_RECOVERY_LIMIT,
  TEMPLATE_ACTOR,
  templateWrite,
  templateDelete,
  savedTemplate,
  templateDirectory,
} from '../../../packages/shared/src/coverage-templates.js';

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const missing = () =>
  new ApiError(
    404,
    'TEMPLATE_UNAVAILABLE',
    'This private coverage template is not available.',
  );
const changed = () =>
  new ApiError(
    409,
    'TEMPLATE_CHANGED',
    'This template changed. Refresh and review the latest template.',
  );
const invalid = () =>
  new ApiError(
    503,
    'TEMPLATE_METADATA_INVALID',
    'A coverage template needs metadata repair.',
  );
export function createCoverageTemplates(
  store: () => LibraryStore,
  owner: (req: Request) => Promise<string>,
) {
  const router = Router(),
    root = '/studio/coverage-templates';
  async function actor(req: Request, write = false) {
    const account = await owner(req),
      expected = req.get(TEMPLATE_ACTOR);
    if ((write || expected) && expected !== account)
      throw new ApiError(
        403,
        'TEMPLATE_ACCOUNT_CHANGED',
        'The signed-in account changed. Reload coverage templates.',
      );
    return account;
  }
  function idOf(value: unknown) {
    const result = z.uuid().safeParse(value);
    if (!result.success) throw missing();
    return result.data;
  }
  function parse(row: LibraryRecord, account: string, id = row.id) {
    if (
      row.id !== id ||
      row.ownerId !== account ||
      row.kind !== 'job' ||
      row.purpose !== 'coverage-template' ||
      row.eventId ||
      row.scanId ||
      row.deletionStartedAt ||
      row.deletionCompletedAt
    )
      throw missing();
    const parsed = savedTemplate.safeParse(row.coverageTemplate);
    if (
      !parsed.success ||
      parsed.data.id !== id ||
      parsed.data.createdAt !== row.createdAt ||
      !/^[a-f0-9]{64}$/.test(row.coverageTemplateCommandDigest ?? '')
    )
      throw invalid();
    return { row, value: parsed.data };
  }
  async function get(id: string, account: string) {
    let row: LibraryRecord;
    try {
      row = await store().get(id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
    return parse(row, account, id);
  }
  async function list(account: string) {
    const rows = (await store().list(account, 'job')).filter(
      (row) => row.purpose === 'coverage-template',
    );
    if (
      rows.length > COVERAGE_TEMPLATE_RECOVERY_LIMIT ||
      new Set(rows.map((row) => row.id)).size !== rows.length
    )
      throw invalid();
    return rows
      .map((row) => parse(row, account).value)
      .sort(
        (a, b) =>
          a.fields.title.localeCompare(b.fields.title) ||
          a.id.localeCompare(b.id),
      );
  }
  router.get(root, async (req, res) => {
    const account = await actor(req);
    res.json(
      await withAccountLock(account, async () =>
        templateDirectory.parse({
          accountId: account,
          limit: COVERAGE_TEMPLATE_LIMIT,
          templates: await list(account),
        }),
      ),
    );
  });
  router.get(`${root}/:id`, async (req, res) => {
    const account = await actor(req),
      id = idOf(req.params.id);
    res.json(
      await withAccountLock(account, async () => {
        const current = await get(id, account);
        if (!current) throw missing();
        return { accountId: account, template: current.value };
      }),
    );
  });
  router.put(`${root}/:id`, async (req, res) => {
    const account = await actor(req, true),
      id = idOf(req.params.id),
      input = templateWrite.safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_TEMPLATE',
        'Enter a name, unique bounded shot categories and the current numeric revision.',
      );
    const command = input.data,
      commandDigest = digest(command);
    res.json(
      await withAccountLock(account, async () => {
        const current = await get(id, account);
        const assertCurrent = async () => {
          if (
            digest((await get(id, account))?.row ?? null) !==
            digest(current?.row ?? null)
          )
            throw changed();
        };
        if (
          current?.value.version === command.version + 1 &&
          current.row.coverageTemplateCommandDigest === commandDigest
        ) {
          await assertCurrent();
          return { accountId: account, template: current.value };
        }
        if (
          (current?.value.version ?? 0) !== command.version ||
          (current?.value.generation ?? null) !== command.generation
        )
          throw changed();
        const templates = await list(account);
        if (!current && templates.length >= COVERAGE_TEMPLATE_LIMIT)
          throw new ApiError(
            409,
            'TEMPLATE_LIMIT',
            'Remove an unused template before adding another.',
          );
        if (
          templates.some(
            (row) =>
              row.id !== id &&
              row.fields.title.toLowerCase() ===
                command.fields.title.toLowerCase(),
          )
        )
          throw new ApiError(
            409,
            'TEMPLATE_NAME_USED',
            'Choose a different template name.',
          );
        const now = new Date(
          Math.max(Date.now(), Date.parse(current?.value.updatedAt ?? '') || 0),
        ).toISOString();
        const value = savedTemplate.parse({
          id,
          generation: current?.value.generation ?? randomUUID(),
          version: command.version + 1,
          fields: command.fields,
          createdAt: current?.value.createdAt ?? now,
          updatedAt: now,
        });
        const row: LibraryRecord = {
          id,
          ownerId: account,
          kind: 'job',
          purpose: 'coverage-template',
          createdAt: value.createdAt,
          coverageTemplate: value,
          coverageTemplateCommandDigest: commandDigest,
        };
        if (Buffer.byteLength(JSON.stringify(row), 'utf8') > 14000)
          throw invalid();
        await assertCurrent();
        await store().put(row, current === null);
        return { accountId: account, template: value };
      }),
    );
  });
  router.delete(`${root}/:id`, async (req, res) => {
    const account = await actor(req, true),
      id = idOf(req.params.id),
      input = templateDelete.safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_TEMPLATE_DELETE',
        'Load the current template before removing it.',
      );
    await withAccountLock(account, async () => {
      const current = await get(id, account);
      if (!current) return;
      if (
        current.value.version !== input.data.version ||
        current.value.generation !== input.data.generation
      )
        throw changed();
      if (digest((await get(id, account))?.row ?? null) !== digest(current.row))
        throw changed();
      try {
        await store().remove(id);
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
    });
    res.status(204).end();
  });
  return router;
}
