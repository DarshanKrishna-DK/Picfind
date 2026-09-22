import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { JobQueue } from '../../apps/api/src/jobs.js';
import { TestJobStore } from '../helpers/job-store.js';
import {
  decodeJobRow,
  decodeManifest,
  encodeManifestJob,
  makeManifest,
  type ManifestRow,
} from '../../apps/api/src/job-manifest.js';
import {
  validImportFileId,
  validImportSource,
} from '../../apps/api/src/import-policy.js';

function input() {
  return {
    ownerId: 'owner',
    eventId: randomUUID(),
    requestId: randomUUID(),
    type: 'cloud-import' as const,
    consentPolicyVersion: 'cloud-import-v1' as const,
    importSource: { provider: 'dropbox' as const, generation: randomUUID() },
    photoIds: ['id:permitted-one', 'id:permitted-two'],
  };
}
describe('cloud import queue manifests without network or face processing', () => {
  it('accepts an explicit source-import policy instead of claiming face-processing consent', async () => {
    const queue = new JobQueue(new TestJobStore()),
      data = input();
    const job = await queue.enqueue(data);
    expect(job.type).toBe('cloud-import');
    expect(job.consentPolicyVersion).toBe('cloud-import-v1');
    expect(job.importSource).toEqual(data.importSource);
    expect(job.photoIds).toEqual(data.photoIds);
    expect(job.indexed).toBe(0);
    expect(job.status).toBe('queued');
  });
  it('binds request reuse to the provider, connection generation and destination', async () => {
    const queue = new JobQueue(new TestJobStore()),
      data = input(),
      saved = await queue.enqueue(data);
    expect(
      (await queue.enqueue({ ...data, photoIds: [...data.photoIds].reverse() }))
        .id,
    ).toBe(saved.id);
    for (const source of [
      { ...data.importSource, provider: 'box' as const },
      { ...data.importSource, generation: randomUUID() },
      { ...data.importSource, destinationEventId: randomUUID() },
    ])
      await expect(
        queue.enqueue({ ...data, importSource: source }),
      ).rejects.toMatchObject({ code: 'JOB_REQUEST_REUSED' });
  });
  it('rejects missing source authority, face-policy imports and paid-retry flags', async () => {
    const queue = new JobQueue(new TestJobStore()),
      data = input();
    const { importSource: _source, ...missing } = data;
    void _source;
    await expect(queue.enqueue(missing)).rejects.toMatchObject({
      code: 'INVALID_JOB',
    });
    await expect(
      queue.enqueue({ ...data, consentPolicyVersion: 'face-matching-v1' }),
    ).rejects.toMatchObject({ code: 'INVALID_JOB' });
    await expect(
      queue.enqueue({ ...data, retryUncertain: true }),
    ).rejects.toMatchObject({ code: 'INVALID_JOB' });
    await expect(
      queue.enqueue({
        ...data,
        type: 'event-index',
        consentPolicyVersion: 'face-matching-v1',
        photoIds: [randomUUID()],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_JOB' });
  });
  it('keeps a worst-size 10,000-file snapshot within both private row and free transaction limits', async () => {
    const queue = new JobQueue(new TestJobStore()),
      data = input();
    const photoIds = Array.from(
      { length: 10000 },
      (_, index) => 'id:' + String(index).padStart(9, '0') + 'x'.repeat(500),
    );
    const job = await queue.enqueue({ ...data, photoIds });
    const manifest = makeManifest(job),
      envelope = encodeManifestJob(job, manifest.reference);
    expect(manifest.reference.version).toBe(2);
    expect(manifest.chunks.length + 1).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(
      64000,
    );
    for (const chunk of manifest.chunks)
      expect(Buffer.byteLength(chunk.payload)).toBeLessThanOrEqual(64000);
    const rows: ManifestRow[] = manifest.chunks.map((part) => ({
      $id: part.id,
      ownerId: job.ownerId,
      jobId: job.id,
      partIndex: part.index,
      payload: part.payload,
    }));
    expect(decodeManifest(envelope, rows).photoIds).toEqual(photoIds);
    const decoded = decodeJobRow({
      $id: job.id,
      ownerId: job.ownerId,
      eventId: job.eventId,
      status: job.status,
      availableAt: job.availableAt,
      payload: JSON.stringify(envelope),
    });
    expect(decoded.type).toBe('cloud-import');
  });
  it('rejects manifest version mixing and source mutation', async () => {
    const queue = new JobQueue(new TestJobStore()),
      job = await queue.enqueue(input());
    const manifest = makeManifest(job),
      envelope = encodeManifestJob(job, manifest.reference);
    const rows: ManifestRow[] = manifest.chunks.map((part) => ({
      $id: part.id,
      ownerId: job.ownerId,
      jobId: job.id,
      partIndex: part.index,
      payload: part.payload,
    }));
    rows[0]!.payload = String(rows[0]!.payload).replace(
      'permitted-one',
      'different-one',
    );
    expect(() => decodeManifest(envelope, rows)).toThrow();
    const bad = { ...envelope, manifest: { ...envelope.manifest, version: 1 } };
    expect(() =>
      decodeJobRow({
        $id: job.id,
        ownerId: job.ownerId,
        eventId: job.eventId,
        status: job.status,
        availableAt: job.availableAt,
        payload: JSON.stringify(bad),
      }),
    ).toThrow();
  });
  it('preserves version-one face manifests', async () => {
    const queue = new JobQueue(new TestJobStore());
    const job = await queue.enqueue({
      ownerId: 'owner',
      eventId: randomUUID(),
      requestId: randomUUID(),
      photoIds: [randomUUID()],
      consentPolicyVersion: 'face-matching-v1',
    });
    expect(makeManifest(job).reference.version).toBe(1);
  });
  it('bounds encoded identifiers and rejects credential-shaped source metadata', () => {
    expect(validImportFileId('a'.repeat(512))).toBe(true);
    expect(validImportFileId('a'.repeat(513))).toBe(false);
    expect(validImportFileId('\\'.repeat(512))).toBe(false);
    expect(validImportFileId('😀'.repeat(256))).toBe(false);
    expect(validImportFileId('bad\nidentifier')).toBe(false);
    expect(
      validImportSource({
        provider: 'box',
        generation: randomUUID(),
        accessToken: 'must-not-enter-jobs',
      }),
    ).toBe(false);
    expect(
      validImportSource({ provider: 'unknown', generation: randomUUID() }),
    ).toBe(false);
  });
});
