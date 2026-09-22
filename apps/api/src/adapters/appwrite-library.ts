import { ApiError } from '../auth.js';
import { eventMembers, membershipInboxId } from '../event-membership-access.js';
import type { LibraryRecord, LibraryStore } from '../library.js';
import type { BillingService } from '../billing/service.js';

interface Config {
  endpoint: string;
  projectId: string;
  apiKey: string;
}
export class AppwriteLibraryStore implements LibraryStore {
  async stageEventImport(
    actor: string,
    root: LibraryRecord,
    previousRequestId?: string,
  ) {
    if (!this.billing)
      throw new ApiError(
        503,
        'EVENT_ACCOUNTING_UNAVAILABLE',
        'Transactional event imports require billing storage.',
      );
    return this.billing.stageEventImport(actor, root, previousRequestId);
  }
  async suppressSyncPhoto(photo: LibraryRecord) {
    if (!this.billing)
      throw new ApiError(
        503,
        'SYNC_CLEANUP_PENDING',
        'Source deletion accounting is unavailable.',
      );
    await this.billing.suppressFolderSyncPhoto(photo);
  }
  private readonly base = '/tablesdb/picfind-library/tables/records/rows';
  constructor(
    private readonly config: Config,
    private readonly billing?: BillingService,
  ) {}
  private async request(
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<Response> {
    const multipart = body instanceof FormData;
    const response = await fetch(
      `${this.config.endpoint.replace(/\/$/, '')}${path}`,
      {
        method,
        headers: {
          'X-Appwrite-Project': this.config.projectId,
          'X-Appwrite-Key': this.config.apiKey,
          ...(!multipart ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined
          ? { body: multipart ? body : JSON.stringify(body) }
          : {}),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      if (response.status === 404)
        throw new ApiError(404, 'NOT_FOUND', 'This item is not available.');
      if (response.status === 409)
        throw new ApiError(409, 'CONFLICT', 'This item already exists.');
      throw new ApiError(
        503,
        'STORAGE_UNAVAILABLE',
        'Photo storage is unavailable. Please try again later.',
      );
    }
    return response;
  }
  async list(ownerId: string, kind: LibraryRecord['kind']) {
    const records: LibraryRecord[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const params = new URLSearchParams();
      for (const query of [
        { method: 'equal', attribute: 'ownerId', values: [ownerId] },
        { method: 'equal', attribute: 'kind', values: [kind] },
        { method: 'orderAsc', attribute: '$id' },
        { method: 'limit', values: [100] },
        ...(cursor ? [{ method: 'cursorAfter', values: [cursor] }] : []),
      ])
        params.append('queries[]', JSON.stringify(query));
      const data = (await (
        await this.request(`${this.base}?${params}`)
      ).json()) as { rows: { $id: string; payload: string }[] };
      records.push(
        ...data.rows.map((row) => JSON.parse(row.payload) as LibraryRecord),
      );
      if (data.rows.length < 100) return records;
      const next = data.rows.at(-1)?.$id;
      if (!next || next === cursor)
        throw new Error('Library pagination did not advance.');
      cursor = next;
    }
    throw new Error('Library listing exceeded its safety boundary.');
  }
  async get(id: string) {
    const row = (await (
      await this.request(`${this.base}/${encodeURIComponent(id)}`)
    ).json()) as { payload: string };
    return JSON.parse(row.payload) as LibraryRecord;
  }
  async expired(before: string, limit: number) {
    const params = new URLSearchParams();
    for (const query of [
      { method: 'equal', attribute: 'kind', values: ['photo', 'job'] },
      { method: 'lessThanEqual', attribute: 'purgeAt', values: [before] },
      { method: 'orderAsc', attribute: 'purgeAt' },
      { method: 'limit', values: [Math.min(100, Math.max(1, limit))] },
    ])
      params.append('queries[]', JSON.stringify(query));
    const result = (await (
      await this.request(`${this.base}?${params}`)
    ).json()) as { rows: { payload: string }[] };
    return result.rows.map((row) => JSON.parse(row.payload) as LibraryRecord);
  }
  async put(record: LibraryRecord, create = false) {
    const data = {
      ownerId: record.ownerId,
      kind: record.kind,
      payload: JSON.stringify(record),
      purgeAt:
        (record.kind === 'photo' || record.purpose === 'upload-cleanup') &&
        record.expiresAt
          ? (record.cleanupAfter ?? record.expiresAt)
          : null,
    };
    await this.request(
      create ? this.base : `${this.base}/${record.id}`,
      create ? 'POST' : 'PATCH',
      create ? { rowId: record.id, data, permissions: [] } : { data },
    );
  }
  async remove(id: string) {
    const record = await this.get(id);
    if (record.kind === 'photo' && record.folderSyncId)
      await this.suppressSyncPhoto(record);
    if (record.kind === 'event') {
      for (const member of eventMembers(record)) {
        const inboxId = membershipInboxId(id, member.userId);
        try {
          const inbox = await this.get(inboxId);
          if (
            inbox.kind !== 'job' ||
            inbox.purpose !== 'event-membership' ||
            inbox.ownerId !== member.userId ||
            inbox.eventId !== id ||
            inbox.membershipEventOwnerId !== record.ownerId
          )
            throw new ApiError(
              503,
              'MEMBERSHIP_INVALID',
              'Event membership cleanup needs maintenance.',
            );
          await this.request(
            `${this.base}/${encodeURIComponent(inboxId)}`,
            'DELETE',
          );
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) throw error;
        }
      }
    }
    if (this.billing) {
      const row = record;
      if (row.kind === 'photo' || row.purpose === 'upload-cleanup')
        await this.billing.releaseStorage(
          row.ownerId,
          row.storageReservationId ?? row.id,
          row.bytes ?? 0,
          async () =>
            (await this.list(row.ownerId, 'photo')).reduce(
              (sum, photo) => sum + (photo.bytes ?? 0),
              0,
            ),
          row.purpose === 'upload-cleanup',
        );
    }
    await this.request(`${this.base}/${encodeURIComponent(id)}`, 'DELETE');
  }
  async upload(id: string, bytes: Uint8Array) {
    const form = new FormData();
    form.set('fileId', id);
    form.set(
      'file',
      new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }),
      `${id}.jpg`,
    );
    await this.request('/storage/buckets/picfind-photos/files', 'POST', form);
  }
  async file(id: string) {
    return this.request(
      `/storage/buckets/picfind-photos/files/${encodeURIComponent(id)}/view`,
    );
  }
  async removeFile(id: string) {
    try {
      await this.request(
        `/storage/buckets/picfind-photos/files/${encodeURIComponent(id)}`,
        'DELETE',
      );
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
  }
}
