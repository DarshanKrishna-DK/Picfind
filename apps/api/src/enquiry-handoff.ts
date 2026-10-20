import { createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { withAccountLock } from './locks.js';
import { enquiryFormId } from './studio-enquiries.js';
import {
  ENQUIRY_ACTOR,
  savedEnquiry,
  type Enquiry,
} from '../../../packages/shared/src/studio-enquiries.js';
import {
  savedClient,
  MAX_STUDIO_CLIENTS,
  type SavedClient,
} from '../../../packages/shared/src/studio-clients.js';
import {
  advanceProject,
  savedProject,
  PROJECT_LIMIT,
} from '../../../packages/shared/src/studio-projects.js';
import {
  enquiryHandoff,
  handoffCommand,
  handoffPreview,
  pendingHandoff,
  type EnquiryHandoff,
  type PendingHandoff,
} from '../../../packages/shared/src/enquiry-handoff.js';

const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const missing = () =>
  new ApiError(
    404,
    'HANDOFF_UNAVAILABLE',
    'This enquiry handoff is unavailable.',
  );
const changed = () =>
  new ApiError(
    409,
    'HANDOFF_CHANGED',
    'The handoff or its source records changed. Load the latest preview before continuing.',
  );
const invalid = () =>
  new ApiError(
    503,
    'HANDOFF_INVALID',
    'These handoff records need metadata repair.',
  );
type Source = {
  row: LibraryRecord;
  enquiry: Enquiry;
  handoff: EnquiryHandoff | null;
};

export function createEnquiryHandoff(
  getStore: () => LibraryStore,
  actorOf: (req: Request) => Promise<string>,
) {
  const router = Router(),
    root = '/studio/enquiries/:id/handoff';
  async function actor(req: Request) {
    const owner = await actorOf(req);
    if (req.get(ENQUIRY_ACTOR) && req.get(ENQUIRY_ACTOR) !== owner)
      throw new ApiError(
        403,
        'HANDOFF_ACCOUNT_CHANGED',
        'Your signed-in account changed. Reload the handoff.',
      );
    return owner;
  }
  function idOf(value: unknown) {
    const parsed = z.uuid().safeParse(value);
    if (!parsed.success) throw missing();
    return parsed.data;
  }
  async function optional(id: string) {
    try {
      return await getStore().get(id);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404) return null;
      throw failure;
    }
  }
  function scoped(
    row: LibraryRecord,
    id: string,
    owner: string,
    purpose: LibraryRecord['purpose'],
  ) {
    return (
      row.id === id &&
      row.ownerId === owner &&
      row.kind === 'job' &&
      row.purpose === purpose &&
      !row.eventId &&
      !row.scanId &&
      !row.deletionStartedAt &&
      !row.deletionCompletedAt
    );
  }
  async function source(id: string, owner: string): Promise<Source> {
    const row = await optional(id);
    if (!row || !scoped(row, id, owner, 'studio-enquiry')) throw missing();
    const value = savedEnquiry.safeParse(row.studioEnquiry);
    const marker =
      row.enquiryHandoff === undefined
        ? null
        : enquiryHandoff.safeParse(row.enquiryHandoff);
    if (
      !value.success ||
      value.data.id !== id ||
      value.data.createdAt !== row.createdAt ||
      value.data.formId !== enquiryFormId(owner) ||
      (marker && !marker.success)
    )
      throw invalid();
    const handoff = marker?.success ? marker.data : null;
    if (handoff && handoff.sourceCreatedAt !== value.data.createdAt)
      throw invalid();
    if (
      handoff?.status === 'pending' &&
      handoff.project.transitions.some((entry) => entry.actorId !== owner)
    )
      throw invalid();
    return { row, enquiry: value.data, handoff };
  }
  function contact(row: LibraryRecord, owner: string) {
    if (!scoped(row, row.id, owner, 'studio-client')) throw missing();
    const parsed = savedClient.safeParse(row.studioClient);
    if (
      !parsed.success ||
      parsed.data.id !== row.id ||
      parsed.data.createdAt !== row.createdAt
    )
      throw invalid();
    return parsed.data;
  }
  async function directory(owner: string) {
    return (await getStore().list(owner, 'job'))
      .filter(
        (row) =>
          row.ownerId === owner &&
          row.kind === 'job' &&
          row.purpose === 'studio-client',
      )
      .map((row) => contact(row, owner))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
  async function destination(
    id: string,
    owner: string,
    kind: 'client' | 'project',
  ) {
    const row = await optional(id);
    if (!row) return null;
    if (
      !scoped(
        row,
        id,
        owner,
        kind === 'client' ? 'studio-client' : 'studio-project',
      ) ||
      row.projectRemovalStartedAt
    )
      return { changed: true as const };
    const parsed =
      kind === 'client'
        ? savedClient.safeParse(row.studioClient)
        : savedProject.safeParse(row.studioProject);
    if (
      !parsed.success ||
      parsed.data.id !== id ||
      parsed.data.createdAt !== row.createdAt
    )
      return { changed: true as const };
    return { value: parsed.data };
  }
  async function targets(marker: EnquiryHandoff, owner: string) {
    const clientId =
      marker.status === 'pending' ? marker.client.id : marker.clientId;
    const projectId =
      marker.status === 'pending' ? marker.project.id : marker.projectId;
    const [client, project] = await Promise.all([
      destination(clientId, owner, 'client'),
      destination(projectId, owner, 'project'),
    ]);
    const view = (
      kind: 'client' | 'project',
      id: string,
      current: typeof client,
    ) => {
      const expected = marker.status === 'pending' ? marker[kind] : null;
      const status = !current
        ? 'missing'
        : 'changed' in current ||
            (expected && hash(current.value) !== hash(expected))
          ? 'changed'
          : 'matching';
      return {
        id,
        name:
          expected?.name ??
          (current && 'value' in current
            ? current.value.name
            : `Unavailable ${kind}`),
        status,
        mayCreate:
          marker.status === 'pending' &&
          status === 'missing' &&
          (kind === 'project' || marker.newClient),
      };
    };
    return {
      views: {
        client: view('client', clientId, client),
        project: view('project', projectId, project),
      },
      token: hash({ marker, client, project }),
    };
  }
  async function preview(id: string, owner: string) {
    const current = await source(id, owner),
      clients = await directory(owner);
    const destinationState = current.handoff
      ? await targets(current.handoff, owner)
      : null;
    return handoffPreview.parse({
      accountId: owner,
      enquiry: current.enquiry,
      sourceToken: hash(current.enquiry),
      clients: clients.slice(0, MAX_STUDIO_CLIENTS),
      totalClients: clients.length,
      handoff: current.handoff,
      targets: destinationState?.views ?? null,
      recoveryToken:
        current.handoff?.status === 'pending' ? destinationState!.token : null,
    });
  }
  async function assertSource(current: Source, owner: string) {
    const fresh = await source(current.row.id, owner);
    if (
      hash({ enquiry: fresh.enquiry, handoff: fresh.handoff }) !==
      hash({ enquiry: current.enquiry, handoff: current.handoff })
    )
      throw changed();
  }
  async function storeMarker(
    current: Source,
    marker: EnquiryHandoff,
    owner: string,
  ) {
    await assertSource(current, owner);
    const now = new Date(
      Math.max(Date.now(), Date.parse(current.enquiry.updatedAt)),
    ).toISOString();
    const enquiry = savedEnquiry.parse({
      ...current.enquiry,
      version: current.enquiry.version + 1,
      updatedAt: now,
    });
    const row = {
      ...current.row,
      studioEnquiry: enquiry,
      enquiryHandoff: marker,
    };
    if (Buffer.byteLength(JSON.stringify(row), 'utf8') > 14000)
      throw new ApiError(
        400,
        'HANDOFF_TOO_LARGE',
        'Shorten the project or contact details before creating this handoff.',
      );
    await getStore().put(row);
    return { row, enquiry, handoff: marker };
  }
  async function quotas(
    owner: string,
    marker: PendingHandoff,
    createIds: Set<string>,
  ) {
    const clients = await directory(owner);
    if (createIds.has(marker.client.id)) {
      if (clients.length >= MAX_STUDIO_CLIENTS)
        throw new ApiError(
          409,
          'CLIENT_LIMIT',
          'Export or remove an unused client before creating another.',
        );
      if (
        marker.client.email &&
        clients.some((client) => client.email === marker.client.email)
      )
        throw new ApiError(
          409,
          'CLIENT_EMAIL_EXISTS',
          'This email already exists. Use that client or abandon this handoff and review it again.',
        );
    }
    if (createIds.has(marker.project.id)) {
      const count = (await getStore().list(owner, 'job')).filter(
        (row) =>
          row.ownerId === owner &&
          row.kind === 'job' &&
          row.purpose === 'studio-project',
      ).length;
      if (count >= PROJECT_LIMIT)
        throw new ApiError(
          409,
          'PROJECT_LIMIT',
          'Remove an unused project before creating another.',
        );
    }
  }
  async function execute(
    current: Source,
    owner: string,
    createIds: Set<string>,
  ) {
    if (current.handoff?.status !== 'pending') throw changed();
    const marker = current.handoff;
    for (const kind of ['client', 'project'] as const) {
      await assertSource(current, owner);
      const state = (await targets(marker, owner)).views[kind],
        expected = marker[kind];
      if (
        state.status === 'changed' ||
        (state.status === 'missing' &&
          (!state.mayCreate || !createIds.has(expected.id)))
      )
        throw changed();
      if (state.status === 'matching') continue;
      await quotas(owner, marker, new Set([expected.id]));
      if (kind === 'project') {
        const client = await destination(marker.client.id, owner, 'client');
        if (
          !client ||
          !('value' in client) ||
          hash(client.value) !== hash(marker.client)
        )
          throw changed();
      }
      await assertSource(current, owner);
      await getStore().put(
        kind === 'client'
          ? {
              id: marker.client.id,
              ownerId: owner,
              kind: 'job',
              purpose: 'studio-client',
              createdAt: marker.client.createdAt,
              studioClient: marker.client,
            }
          : {
              id: marker.project.id,
              ownerId: owner,
              kind: 'job',
              purpose: 'studio-project',
              createdAt: marker.project.createdAt,
              studioProject: marker.project,
              projectCommandDigest: marker.requestDigest,
            },
        true,
      );
    }
    const final = (await targets(marker, owner)).views;
    if (
      final.client.status !== 'matching' ||
      final.project.status !== 'matching'
    )
      throw changed();
    await finish(current, owner, 'completed');
  }
  async function finish(
    current: Source,
    owner: string,
    status: 'completed' | 'abandoned',
  ) {
    const marker = current.handoff;
    if (marker?.status !== 'pending') throw changed();
    await storeMarker(
      current,
      enquiryHandoff.parse({
        status,
        operationId: marker.operationId,
        requestDigest: marker.requestDigest,
        sourceCreatedAt: marker.sourceCreatedAt,
        startedAt: marker.startedAt,
        finishedAt: new Date(
          Math.max(Date.now(), Date.parse(marker.startedAt)),
        ).toISOString(),
        newClient: marker.newClient,
        clientId: marker.client.id,
        projectId: marker.project.id,
      }),
      owner,
    );
  }
  router.get(root, async (req, res) => {
    const owner = await actor(req),
      id = idOf(req.params.id);
    res.json(await withAccountLock(owner, () => preview(id, owner)));
  });
  router.put(root, async (req, res) => {
    const owner = await actor(req),
      id = idOf(req.params.id),
      input = handoffCommand.safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_HANDOFF',
        'Review the source, contact and project details and use the current preview.',
      );
    res.json(
      await withAccountLock(owner, async () => {
        let current = await source(id, owner);
        const command = input.data;
        if (command.action === 'start') {
          const digest = hash(command);
          if (current.handoff) {
            if (
              current.handoff.operationId === command.operationId &&
              current.handoff.requestDigest === digest &&
              current.handoff.status === 'completed'
            )
              return preview(id, owner);
            throw new ApiError(
              409,
              'HANDOFF_EXISTS',
              'A handoff is already recorded. Load its status to resume or open the resulting work.',
            );
          }
          if (
            current.enquiry.version !== command.version ||
            hash(current.enquiry) !== command.sourceToken
          )
            throw changed();
          const now = new Date(
            Math.max(Date.now(), Date.parse(current.enquiry.updatedAt)),
          ).toISOString();
          let client: SavedClient;
          if (command.client.mode === 'existing') {
            const existing = await destination(
              command.client.snapshot.id,
              owner,
              'client',
            );
            if (
              !existing ||
              !('value' in existing) ||
              hash(existing.value) !== hash(command.client.snapshot)
            )
              throw changed();
            client = command.client.snapshot;
          } else {
            if (await optional(command.client.id)) throw missing();
            client = savedClient.parse({
              ...command.client.fields,
              id: command.client.id,
              version: 1,
              createdAt: now,
              updatedAt: now,
            });
          }
          if (
            command.project.id === client.id ||
            command.project.id === id ||
            client.id === id ||
            (await optional(command.project.id))
          )
            throw missing();
          const project = advanceProject(
            null,
            command.project.id,
            {
              name: command.project.name,
              summary: command.project.summary,
              stage: 'inquiry',
              clientId: client.id,
              eventIds: [],
            },
            'Created from a studio enquiry',
            owner,
            now,
          );
          const marker = pendingHandoff.parse({
            status: 'pending',
            operationId: command.operationId,
            requestDigest: digest,
            sourceCreatedAt: current.enquiry.createdAt,
            startedAt: now,
            newClient: command.client.mode === 'new',
            client,
            project,
          });
          const createIds = new Set([
            project.id,
            ...(marker.newClient ? [client.id] : []),
          ]);
          await quotas(owner, marker, createIds);
          current = await storeMarker(current, marker, owner);
          await execute(current, owner, createIds);
        } else {
          const marker = current.handoff;
          if (!marker || marker.operationId !== command.operationId)
            throw changed();
          if (marker.status !== 'pending') {
            if (
              (command.action === 'resume' && marker.status === 'completed') ||
              (command.action === 'abandon' && marker.status === 'abandoned')
            )
              return preview(id, owner);
            throw changed();
          }
          const state = await targets(marker, owner);
          if (state.token !== command.recoveryToken) throw changed();
          if (command.action === 'abandon')
            await finish(current, owner, 'abandoned');
          else {
            const allowed = Object.values(state.views)
              .filter((target) => target.mayCreate)
              .map((target) => target.id)
              .sort();
            if (
              JSON.stringify([...command.createMissing].sort()) !==
              JSON.stringify(allowed)
            )
              throw new ApiError(
                409,
                'HANDOFF_CONFIRM_MISSING',
                'Explicitly confirm the missing planned records shown in the latest recovery preview.',
              );
            await execute(current, owner, new Set(command.createMissing));
          }
        }
        return preview(id, owner);
      }),
    );
  });
  return router;
}
