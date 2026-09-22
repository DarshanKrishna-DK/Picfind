import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { JobQueue, publicJob } from '../../apps/api/src/jobs.js';
import {
  decodeJobRow,
  decodeManifest,
  encodeManifestJob,
  makeManifest,
  summarizeJob,
} from '../../apps/api/src/job-manifest.js';
import { TestJobStore } from '../helpers/job-store.js';

async function fixture(count = 10000) {
  const photoIds = Array.from({ length: count }, (_, i) =>
    i.toString(36).padStart(64, '0'),
  );
  const job = await new JobQueue(new TestJobStore()).enqueue({
    ownerId: randomUUID(),
    eventId: randomUUID(),
    requestId: randomUUID(),
    photoIds,
    retryUncertain: true,
    retryUncertainPhotoIds: photoIds,
    consentPolicyVersion: 'face-matching-v1',
  });
  const manifest = makeManifest(job);
  const encoded = encodeManifestJob(job, manifest.reference);
  const rows = manifest.chunks.map((part) => ({
    $id: part.id,
    ownerId: job.ownerId,
    jobId: job.id,
    partIndex: part.index,
    payload: part.payload,
  }));
  return { job, manifest, encoded, rows };
}
describe('bounded immutable job manifests', () => {
  it('keeps the worst-size 10,000-photo job within every private column bound', async () => {
    const f = await fixture();
    expect(f.rows).toHaveLength(25);
    expect(f.rows.every((row) => Buffer.byteLength(row.payload) < 64000)).toBe(
      true,
    );
    expect(Buffer.byteLength(JSON.stringify(f.encoded))).toBeLessThan(64000);
    expect('photoIds' in f.encoded).toBe(false);
    expect(decodeManifest(f.encoded, f.rows.reverse())).toEqual(
      f.manifest.contents,
    );
    expect(publicJob(summarizeJob(f.encoded)).total).toBe(10000);
  });
  it('bounds failed-photo samples without hiding the exact failure count', async () => {
    const f = await fixture();
    f.job.failed = 10000;
    f.job.failedPhotoIds = [...f.job.photoIds];
    const encoded = encodeManifestJob(f.job, f.manifest.reference);
    expect(encoded.failed).toBe(10000);
    expect(encoded.failedPhotoIds).toHaveLength(100);
    expect(encoded.failedPhotoIdsTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(encoded))).toBeLessThan(64000);
  });
  it('rejects incomplete, cross-owner, duplicated and tampered snapshots', async () => {
    const f = await fixture(401);
    expect(() => decodeManifest(f.encoded, f.rows.slice(1))).toThrow('repair');
    expect(() =>
      decodeManifest(f.encoded, [
        { ...f.rows[0]!, ownerId: 'another-owner' },
        f.rows[1]!,
      ]),
    ).toThrow('repair');
    expect(() => decodeManifest(f.encoded, [f.rows[0]!, f.rows[0]!])).toThrow(
      'repair',
    );
    const payload = JSON.parse(f.rows[0]!.payload) as { photoIds: string[] };
    payload.photoIds[0] = 'different-photo';
    expect(() =>
      decodeManifest(f.encoded, [
        { ...f.rows[0]!, payload: JSON.stringify(payload) },
        f.rows[1]!,
      ]),
    ).toThrow('repair');
  });
  it('reads existing inline job records while listing only summary metadata', async () => {
    const f = await fixture(20);
    const legacy = decodeJobRow({
      $id: f.job.id,
      ownerId: f.job.ownerId,
      eventId: f.job.eventId,
      status: f.job.status,
      availableAt: f.job.availableAt,
      payload: JSON.stringify(f.job),
    });
    expect(legacy).toEqual(f.job);
    const summary = summarizeJob(legacy);
    expect(summary.photoIds).toBeUndefined();
    expect(publicJob(summary).total).toBe(20);
  });
});
