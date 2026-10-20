import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  UploadQueueController,
  UploadQueueBusy,
  UploadQueueFailure,
} from '../../apps/web/src/features/upload-queue-controller';
import {
  uploadQueueKey,
  parseUploadQueue,
  type UploadQueue,
} from '../../packages/shared/src/upload-queue';

const file = (text: string, name = `${text}.jpg`) =>
  new File([text], name, { type: 'image/jpeg' });
function fixture() {
  const data = new Map<string, string>(),
    held = new Set<string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
  const upload = vi.fn<
    (file: File, item: unknown, signal: AbortSignal) => Promise<string>
  >(async () => randomUUID());
  const digest = vi.fn(async (input: File) =>
    createHash('sha256')
      .update(Buffer.from(await input.arrayBuffer()))
      .digest('hex'),
  );
  function controller(accountId = 'owner', eventId: string | null = null) {
    const key = uploadQueueKey(accountId, eventId);
    return new UploadQueueController({
      accountId,
      eventId,
      storage,
      upload,
      digest,
      changed: () => {},
      exclusive: async (work) => {
        if (held.has(key)) throw new UploadQueueBusy();
        held.add(key);
        try {
          await work();
        } finally {
          held.delete(key);
        }
      },
    });
  }
  return { data, storage, upload, digest, controller };
}
describe('saved browser upload queues with synthetic files and storage', () => {
  it('prepares a bounded metadata-only batch and deduplicates identical input bytes', async () => {
    const f = fixture(),
      queue = f.controller();
    await queue.refresh();
    await queue.prepare([
      file('private-original', 'first.jpg'),
      file('private-original', 'copy.jpg'),
    ]);
    expect(queue.view.queue!.items).toHaveLength(1);
    expect(queue.view.queue!.items[0]!.name).toBe('first.jpg');
    expect(queue.view.attached).toBe(1);
    const serialized = f.data.get(queue.key)!;
    expect(serialized).not.toContain('private-original');
    expect(serialized).not.toContain('data:image');
    expect(queue.view.queue!.items[0]!.digest).toHaveLength(64);
    expect(f.upload).not.toHaveBeenCalled();
  });
  it('survives a new controller, matches renamed originals and skips acknowledged items', async () => {
    const f = fixture(),
      first = f.controller();
    await first.refresh();
    await first.prepare([file('a'), file('b')]);
    f.upload.mockRejectedValueOnce(
      new UploadQueueFailure('Temporary failure', false),
    );
    await first.run();
    expect(first.view.queue!.items.map((item) => item.status)).toEqual([
      'failed',
      'complete',
    ]);
    const second = f.controller();
    await second.refresh();
    expect(second.view.attached).toBe(0);
    await expect(second.run()).rejects.toThrow('Reselect originals');
    await second.prepare([file('a', 'renamed.jpg'), file('b')]);
    expect(second.view.attached).toBe(1);
    await second.run();
    expect(second.view.queue!.mode).toBe('complete');
    expect(f.upload).toHaveBeenCalledTimes(3);
    expect(f.upload.mock.calls[2]![1]).toMatchObject({ name: 'a.jpg' });
  });
  it('rejects nonmatching reselected content without changing saved progress', async () => {
    const f = fixture(),
      queue = f.controller();
    await queue.prepare([file('original', 'same.jpg')]);
    const saved = f.data.get(queue.key);
    queue.dispose();
    const restored = f.controller();
    await restored.refresh();
    await expect(
      restored.prepare([file('different', 'same.jpg')]),
    ).rejects.toThrow('None of these files match');
    expect(restored.view.attached).toBe(0);
    expect(f.data.get(queue.key)).toBe(saved);
  });
  it('pauses an ambiguous request and never starts the next file until explicit resume', async () => {
    const f = fixture(),
      queue = f.controller();
    await queue.prepare([file('a'), file('b')]);
    f.upload.mockImplementationOnce(
      (_file, _item, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('Aborted')), {
            once: true,
          });
        }),
    );
    const running = queue.run();
    await vi.waitFor(() => expect(f.upload).toHaveBeenCalledOnce());
    expect(queue.view.queue!.items.map((item) => item.status)).toEqual([
      'uploading',
      'pending',
    ]);
    queue.pause();
    await running;
    expect(queue.view.queue!.mode).toBe('paused');
    expect(queue.view.queue!.items.map((item) => item.status)).toEqual([
      'pending',
      'pending',
    ]);
    expect(f.upload).toHaveBeenCalledOnce();
    await queue.run();
    expect(f.upload).toHaveBeenCalledTimes(3);
    expect(queue.view.queue!.mode).toBe('complete');
  });
  it('cancels unfinished work while preserving completed acknowledgements', async () => {
    const f = fixture(),
      queue = f.controller();
    await queue.prepare([file('a'), file('b'), file('c')]);
    f.upload.mockResolvedValueOnce('first-photo');
    f.upload.mockImplementationOnce(
      (_file, _item, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('Aborted')), {
            once: true,
          });
        }),
    );
    const running = queue.run();
    await vi.waitFor(() => expect(f.upload).toHaveBeenCalledTimes(2));
    await queue.cancel();
    await running;
    expect(queue.view.queue!.mode).toBe('cancelled');
    expect(queue.view.queue!.items.map((item) => item.status)).toEqual([
      'complete',
      'cancelled',
      'cancelled',
    ]);
    expect(queue.view.queue!.items[0]!.photoId).toBe('first-photo');
    await queue.run();
    expect(queue.view.queue!.mode).toBe('complete');
    expect(f.upload).toHaveBeenCalledTimes(4);
  });
  it('pauses on account or capacity rejection without sending later files', async () => {
    const f = fixture(),
      queue = f.controller();
    await queue.prepare([file('a'), file('b')]);
    f.upload.mockRejectedValueOnce(
      new UploadQueueFailure('Account changed', true),
    );
    await queue.run();
    expect(f.upload).toHaveBeenCalledOnce();
    expect(queue.view.queue!.mode).toBe('paused');
    expect(queue.view.queue!.items.map((item) => item.status)).toEqual([
      'failed',
      'pending',
    ]);
  });
  it('stops before sending when durable progress cannot be written', async () => {
    const f = fixture(),
      queue = f.controller();
    await queue.prepare([file('a')]);
    const prior = f.data.get(queue.key);
    f.storage.setItem.mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    await expect(queue.run()).rejects.toThrow('storage is unavailable');
    expect(f.data.get(queue.key)).toBe(prior);
    expect(f.upload).not.toHaveBeenCalled();
  });
  it('recovers an acknowledged upload whose progress write failed', async () => {
    const f = fixture(),
      queue = f.controller();
    await queue.prepare([file('a')]);
    const persist = f.storage.setItem.getMockImplementation()!;
    let fail = true;
    f.storage.setItem.mockImplementation((key, value) => {
      const saved = JSON.parse(value) as UploadQueue;
      if (fail && saved.items[0]!.status === 'complete') {
        fail = false;
        throw new Error('Disk full');
      }
      persist(key, value);
    });
    f.upload.mockResolvedValue('same-server-photo');
    await expect(queue.run()).rejects.toThrow('storage is unavailable');
    expect(JSON.parse(f.data.get(queue.key)!).items[0].status).toBe(
      'uploading',
    );
    queue.dispose();
    const restored = f.controller();
    await restored.refresh();
    expect(restored.view.queue!.items[0]!.status).toBe('pending');
    await restored.prepare([file('a')]);
    await restored.run();
    expect(restored.view.queue!.items[0]!.photoId).toBe('same-server-photo');
    expect(restored.view.queue!.mode).toBe('complete');
  });
  it('blocks a second tab from running or clearing an active batch', async () => {
    const f = fixture(),
      first = f.controller(),
      second = f.controller();
    await first.prepare([file('a')]);
    f.upload.mockImplementationOnce(
      (_file, _item, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('Aborted')), {
            once: true,
          });
        }),
    );
    const running = first.run();
    await vi.waitFor(() => expect(f.upload).toHaveBeenCalledOnce());
    await expect(second.refresh()).rejects.toBeInstanceOf(UploadQueueBusy);
    await expect(second.clear()).rejects.toBeInstanceOf(UploadQueueBusy);
    await expect(second.run()).rejects.toBeInstanceOf(UploadQueueBusy);
    first.pause();
    await running;
    await second.refresh();
    expect(second.view.externalBusy).toBe(false);
    expect(second.view.queue!.mode).toBe('paused');
  });
  it('rejects stale revisions instead of overwriting another tab', async () => {
    const f = fixture(),
      first = f.controller(),
      second = f.controller();
    await first.prepare([file('a')]);
    await second.refresh();
    await first.cancel();
    const latest = f.data.get(first.key);
    await expect(second.prepare([file('a')])).rejects.toThrow(
      'changed in another tab',
    );
    expect(f.data.get(first.key)).toBe(latest);
    expect(f.upload).not.toHaveBeenCalled();
  });
  it('isolates saved records by actor and destination', async () => {
    const f = fixture(),
      one = f.controller('owner', 'event-one');
    await one.prepare([file('a')]);
    for (const other of [
      f.controller('another', 'event-one'),
      f.controller('owner', 'event-two'),
      f.controller('owner'),
    ]) {
      await other.refresh();
      expect(other.view.queue).toBeNull();
      await other.prepare([file('b')]);
    }
    expect(f.data.size).toBe(4);
  });
  it('does not overwrite malformed saved data and only clears it on explicit action', async () => {
    const f = fixture(),
      queue = f.controller();
    f.data.set(queue.key, '{broken');
    await expect(queue.refresh()).rejects.toThrow('damaged');
    await expect(queue.prepare([file('a')])).rejects.toThrow('damaged');
    expect(f.data.get(queue.key)).toBe('{broken');
    await queue.clear();
    expect(f.data.has(queue.key)).toBe(false);
  });
  it('refuses a manifest copied into another account key', async () => {
    const f = fixture(),
      owner = f.controller(),
      other = f.controller('other');
    await owner.prepare([file('a')]);
    f.data.set(other.key, f.data.get(owner.key)!);
    await expect(other.refresh()).rejects.toThrow('another destination');
    expect(f.upload).not.toHaveBeenCalled();
  });
  it.each(
    [
      [],
      [new File([], 'empty.jpg', { type: 'image/jpeg' })],
      [new File(['svg'], 'bad.svg', { type: 'image/svg+xml' })],
      Array.from({ length: 101 }, (_, i) => file(String(i))),
      [
        new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'large.jpg', {
          type: 'image/jpeg',
        }),
      ],
    ].map((files) => ({ files })),
  )(
    'rejects invalid batch %# before hashing or persistence',
    async ({ files }) => {
      const f = fixture(),
        queue = f.controller();
      await expect(queue.prepare(files)).rejects.toThrow();
      expect(f.digest).not.toHaveBeenCalled();
      expect(f.storage.setItem).not.toHaveBeenCalled();
    },
  );
  it('stops and preserves recovery when the component is disposed', async () => {
    const f = fixture(),
      queue = f.controller();
    await queue.prepare([file('a'), file('b')]);
    f.upload.mockImplementationOnce(
      (_file, _item, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('Aborted')), {
            once: true,
          });
        }),
    );
    const running = queue.run();
    await vi.waitFor(() => expect(f.upload).toHaveBeenCalledOnce());
    queue.dispose();
    await running;
    expect(f.upload).toHaveBeenCalledOnce();
    expect(parseUploadQueue(f.data.get(queue.key)!, 'owner', null)!.mode).toBe(
      'paused',
    );
  });
});
