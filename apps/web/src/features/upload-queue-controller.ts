import {
  parseUploadQueue,
  uploadQueueKey,
  uploadQueueSchema,
  UPLOAD_FILE_LIMIT,
  UPLOAD_QUEUE_LIMIT,
  UPLOAD_QUEUE_STORAGE_LIMIT,
  UPLOAD_TYPES,
  type UploadQueue,
  type UploadQueueItem,
} from '../../../../packages/shared/src/upload-queue';

export class UploadQueueBusy extends Error {
  constructor() {
    super(
      'This saved queue is active in another tab. Refresh after that tab pauses or finishes.',
    );
  }
}
export class UploadQueueStorageError extends Error {
  constructor() {
    super(
      'Saved queue storage is unavailable. Uploads stopped; no further files were sent.',
    );
  }
}
export class UploadQueueFailure extends Error {
  constructor(
    message: string,
    readonly pauseBatch: boolean,
  ) {
    super(message);
  }
}
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Operation = 'prepare' | 'run' | 'refresh' | 'clear' | 'cancel' | null;
export interface UploadQueueView {
  queue: UploadQueue | null;
  operation: Operation;
  attached: number;
  externalBusy: boolean;
}
interface Dependencies {
  accountId: string;
  eventId: string | null;
  storage: StoragePort;
  exclusive: (work: () => Promise<void>) => Promise<void>;
  digest: (file: File) => Promise<string>;
  upload: (
    file: File,
    item: UploadQueueItem,
    signal: AbortSignal,
  ) => Promise<string>;
  changed: (view: UploadQueueView) => void;
}
const changed = () =>
  new Error(
    'The saved queue changed in another tab. Review the refreshed progress before continuing.',
  );
function resetItem(
  item: UploadQueueItem,
  status: 'pending' | 'cancelled',
): UploadQueueItem {
  const { error, photoId, ...rest } = item;
  void error;
  void photoId;
  return { ...rest, status };
}

export class UploadQueueController {
  readonly key: string;
  private current: UploadQueue | null = null;
  private rawSeen: string | null | undefined;
  private files = new Map<string, File>();
  private operation: Operation = null;
  private pending: AbortController | null = null;
  private stop: 'paused' | 'cancelled' | null = null;
  private externalBusy = false;
  private disposed = false;
  constructor(private readonly deps: Dependencies) {
    this.key = uploadQueueKey(deps.accountId, deps.eventId);
  }
  get view(): UploadQueueView {
    return {
      queue: this.current,
      operation: this.operation,
      externalBusy: this.externalBusy,
      attached:
        this.current?.items.filter(
          (item) => item.status !== 'complete' && this.files.has(item.digest),
        ).length ?? 0,
    };
  }
  private notify() {
    if (!this.disposed) this.deps.changed(this.view);
  }
  private raw() {
    try {
      return this.deps.storage.getItem(this.key);
    } catch {
      throw new UploadQueueStorageError();
    }
  }
  private read() {
    const raw = this.raw();
    this.rawSeen = raw;
    try {
      const queue = parseUploadQueue(
        raw,
        this.deps.accountId,
        this.deps.eventId,
      );
      if (queue?.id !== this.current?.id) this.files.clear();
      this.current = queue;
      return queue;
    } catch (failure) {
      this.current = null;
      this.files.clear();
      this.notify();
      throw failure;
    }
  }
  private save(queue: UploadQueue) {
    if (this.raw() !== this.rawSeen) {
      this.read();
      this.notify();
      throw changed();
    }
    const next = uploadQueueSchema.parse({
      ...queue,
      revision: queue.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    const text = JSON.stringify(next);
    if (text.length > UPLOAD_QUEUE_STORAGE_LIMIT)
      throw new UploadQueueStorageError();
    try {
      this.deps.storage.setItem(this.key, text);
    } catch {
      throw new UploadQueueStorageError();
    }
    this.rawSeen = text;
    this.current = next;
    this.notify();
  }
  private async perform(
    operation: Exclude<Operation, null>,
    work: (signal: AbortSignal) => Promise<void>,
    checkRevision = true,
  ) {
    if (this.disposed || this.operation) return;
    const expected = this.rawSeen;
    const controller = new AbortController();
    this.pending = controller;
    this.operation = operation;
    this.stop = null;
    this.externalBusy = false;
    this.notify();
    try {
      await this.deps.exclusive(async () => {
        if (controller.signal.aborted) return;
        this.read();
        this.notify();
        if (
          checkRevision &&
          expected !== undefined &&
          expected !== this.rawSeen
        )
          throw changed();
        await work(controller.signal);
      });
    } catch (failure) {
      if (failure instanceof UploadQueueBusy) this.externalBusy = true;
      throw failure;
    } finally {
      this.pending = null;
      this.operation = null;
      this.notify();
    }
  }
  async refresh() {
    if (this.operation || this.disposed) return;
    this.read();
    this.notify();
    await this.perform(
      'refresh',
      async () => {
        if (this.current?.mode === 'running')
          this.save({
            ...this.current,
            mode: 'paused',
            items: this.current.items.map((item) =>
              item.status === 'uploading' ? resetItem(item, 'pending') : item,
            ),
          });
      },
      false,
    );
  }
  async prepare(selected: File[]) {
    await this.perform('prepare', async (signal) => {
      if (!selected.length || selected.length > UPLOAD_QUEUE_LIMIT)
        throw new Error(`Choose between 1 and ${UPLOAD_QUEUE_LIMIT} files.`);
      if (
        selected.some(
          (file) =>
            !UPLOAD_TYPES.includes(
              file.type as (typeof UPLOAD_TYPES)[number],
            ) ||
            !file.size ||
            file.size > UPLOAD_FILE_LIMIT ||
            !file.name ||
            file.name.length > 255,
        )
      )
        throw new Error(
          'Choose JPEG, PNG or WebP files with valid names, each between 1 byte and 8 MiB.',
        );
      const prepared = new Map<string, { file: File; digest: string }>();
      for (const file of selected) {
        if (signal.aborted) return;
        const digest = await this.deps.digest(file);
        if (signal.aborted) return;
        if (!/^[0-9a-f]{64}$/.test(digest))
          throw new Error('Could not fingerprint this file.');
        if (!prepared.has(digest)) prepared.set(digest, { file, digest });
      }
      if (this.current) {
        const matched = [...prepared.values()].filter(({ file, digest }) =>
          this.current!.items.some(
            (item) =>
              item.digest === digest &&
              item.size === file.size &&
              item.status !== 'complete',
          ),
        );
        if (!matched.length)
          throw new Error(
            'None of these files match unfinished items in this saved batch.',
          );
        const queue = this.current;
        if (queue.mode === 'running')
          this.save({
            ...queue,
            mode: 'paused',
            items: queue.items.map((item) =>
              item.status === 'uploading' ? resetItem(item, 'pending') : item,
            ),
          });
        for (const { file, digest } of matched) this.files.set(digest, file);
      } else {
        const now = new Date().toISOString();
        this.save({
          schema: 1,
          id: crypto.randomUUID(),
          accountId: this.deps.accountId,
          eventId: this.deps.eventId,
          revision: 0,
          createdAt: now,
          updatedAt: now,
          mode: 'paused',
          items: [...prepared.values()].map(({ file, digest }) => ({
            id: crypto.randomUUID(),
            name: file.name,
            size: file.size,
            type: file.type as UploadQueueItem['type'],
            digest,
            status: 'pending',
          })),
        });
        for (const { file, digest } of prepared.values())
          this.files.set(digest, file);
      }
      this.notify();
    });
  }
  async run() {
    await this.perform('run', async (signal) => {
      if (!this.current)
        throw new Error('Choose files for a saved batch first.');
      const candidates = this.current.items.filter(
        (item) => item.status !== 'complete' && this.files.has(item.digest),
      );
      if (!candidates.length)
        throw new Error('Reselect originals to resume unfinished uploads.');
      this.save({
        ...this.current,
        mode: 'running',
        items: this.current.items.map((item) =>
          item.status === 'uploading' || item.status === 'cancelled'
            ? resetItem(item, 'pending')
            : item,
        ),
      });
      for (const candidate of candidates) {
        if (signal.aborted) break;
        const file = this.files.get(candidate.digest)!;
        const item = this.current!.items.find(
          (row) => row.id === candidate.id,
        )!;
        this.save({
          ...this.current!,
          items: this.current!.items.map((row) =>
            row.id === item.id
              ? { ...resetItem(row, 'pending'), status: 'uploading' }
              : row,
          ),
        });
        let photoId: string;
        try {
          photoId = await this.deps.upload(file, item, signal);
          if (signal.aborted) break;
          if (typeof photoId !== 'string' || !photoId || photoId.length > 128)
            throw new UploadQueueFailure(
              'The upload acknowledgement was invalid. Retry to recover it.',
              true,
            );
        } catch (failure) {
          if (signal.aborted) break;
          if (failure instanceof UploadQueueStorageError) throw failure;
          this.save({
            ...this.current!,
            items: this.current!.items.map((row) =>
              row.id === item.id
                ? {
                    ...row,
                    status: 'failed',
                    error:
                      (failure instanceof Error
                        ? failure.message
                        : 'Upload failed.'
                      ).slice(0, 240) || 'Upload failed.',
                  }
                : row,
            ),
          });
          if (failure instanceof UploadQueueFailure && failure.pauseBatch)
            break;
          continue;
        }
        this.save({
          ...this.current!,
          items: this.current!.items.map((row) =>
            row.id === item.id ? { ...row, status: 'complete', photoId } : row,
          ),
        });
        this.files.delete(item.digest);
      }
      const cancelled = this.stop === 'cancelled';
      const items = this.current!.items.map((item) => {
        if (item.status === 'complete') return item;
        if (cancelled) return resetItem(item, 'cancelled');
        return item.status === 'uploading' ? resetItem(item, 'pending') : item;
      });
      this.save({
        ...this.current!,
        items,
        mode: items.every((item) => item.status === 'complete')
          ? 'complete'
          : cancelled
            ? 'cancelled'
            : 'paused',
      });
    });
  }
  pause() {
    this.stop = 'paused';
    this.pending?.abort();
  }
  async cancel() {
    if (this.operation) {
      this.stop = 'cancelled';
      this.pending?.abort();
      return;
    }
    await this.perform('cancel', async () => {
      if (this.current)
        this.save({
          ...this.current,
          mode: 'cancelled',
          items: this.current.items.map((item) =>
            item.status === 'complete' ? item : resetItem(item, 'cancelled'),
          ),
        });
    });
  }
  async clear() {
    if (this.operation || this.disposed) return;
    const expected = this.rawSeen;
    this.operation = 'clear';
    this.notify();
    try {
      await this.deps.exclusive(async () => {
        if (expected === undefined || this.raw() !== expected) {
          this.read();
          throw changed();
        }
        try {
          this.deps.storage.removeItem(this.key);
        } catch {
          throw new UploadQueueStorageError();
        }
        this.current = null;
        this.rawSeen = null;
        this.files.clear();
      });
    } finally {
      this.operation = null;
      this.notify();
    }
  }
  dispose() {
    this.disposed = true;
    this.pause();
    this.files.clear();
  }
}
