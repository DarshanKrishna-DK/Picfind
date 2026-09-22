import { createHash } from 'node:crypto';
import { ApiError } from './auth.js';
import type { JobListEntry, JobRecord } from './jobs.js';
import { validImportFileId, validImportSource } from './import-policy.js';

export const MAX_JOB_PHOTOS = 10_000;
export const MANIFEST_PART_SIZE = 400;
export const IMPORT_MANIFEST_PART_SIZE = 120;
export const FAILED_PHOTO_SAMPLE_LIMIT = 100;
export interface ManifestReference {
  version: 1 | 2;
  parts: number;
  digest: string;
}
export interface ManifestContents {
  photoIds: string[];
  retryUncertainPhotoIds: string[];
}
export interface ManifestJob extends Omit<
  JobRecord,
  'photoIds' | 'retryUncertainPhotoIds'
> {
  manifest: ManifestReference;
  photoCount: number;
}
export type JobEnvelope = JobRecord | ManifestJob;
export interface ManifestRow {
  $id: string;
  ownerId: unknown;
  jobId: unknown;
  partIndex: unknown;
  payload: unknown;
}
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = () =>
  new ApiError(503, 'JOB_STORAGE_INVALID', 'Processing metadata needs repair.');
const validId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(id);
function shape(
  job: Pick<
    JobRecord,
    'type' | 'importSource' | 'consentPolicyVersion' | 'retryUncertain'
  >,
) {
  const importing = job.type === 'cloud-import';
  if (
    importing
      ? !validImportSource(job.importSource) ||
        job.consentPolicyVersion !== 'cloud-import-v1' ||
        job.retryUncertain
      : job.importSource !== undefined
  )
    throw invalid();
  const version: 1 | 2 = importing ? 2 : 1;
  return {
    version,
    partSize: importing ? IMPORT_MANIFEST_PART_SIZE : MANIFEST_PART_SIZE,
    validId: importing ? validImportFileId : validId,
  };
}
export const manifestPartId = (jobId: string, index: number) =>
  createHash('sha256')
    .update(jobId + ':' + index)
    .digest('hex')
    .slice(0, 36);
export function hasManifest(job: JobEnvelope): job is ManifestJob {
  return 'manifest' in job;
}
export function manifestContents(job: JobRecord): ManifestContents {
  return {
    photoIds: [...job.photoIds],
    retryUncertainPhotoIds: [...(job.retryUncertainPhotoIds ?? [])].sort(),
  };
}
export function manifestHash(contents: ManifestContents) {
  return digest(contents);
}
export function makeManifest(job: JobRecord) {
  const format = shape(job);
  const contents = manifestContents(job);
  const ids = new Set(contents.photoIds);
  if (
    !ids.size ||
    ids.size !== contents.photoIds.length ||
    ids.size > MAX_JOB_PHOTOS ||
    contents.photoIds.some((id) => !format.validId(id)) ||
    (job.type === 'cloud-import' &&
      contents.retryUncertainPhotoIds.length > 0) ||
    contents.retryUncertainPhotoIds.some((id) => !ids.has(id))
  )
    throw invalid();
  const chunks: { id: string; index: number; payload: string }[] = [];
  const retry = new Set(contents.retryUncertainPhotoIds);
  for (
    let start = 0;
    start < contents.photoIds.length;
    start += format.partSize
  ) {
    const index = chunks.length;
    const photoIds = contents.photoIds.slice(start, start + format.partSize);
    const payload = JSON.stringify({
      version: format.version,
      ownerId: job.ownerId,
      eventId: job.eventId,
      jobId: job.id,
      index,
      photoIds,
      retryUncertainPhotoIds: photoIds.filter((id) => retry.has(id)),
    });
    if (Buffer.byteLength(payload) > 64000) throw invalid();
    chunks.push({ id: manifestPartId(job.id, index), index, payload });
  }
  const reference: ManifestReference = {
    version: format.version,
    parts: chunks.length,
    digest: digest(contents),
  };
  return { reference, chunks, contents };
}
export function encodeManifestJob(
  job: JobRecord,
  manifest: ManifestReference,
): ManifestJob {
  const { photoIds, retryUncertainPhotoIds: _retryIds, ...metadata } = job;
  void _retryIds;
  const result: ManifestJob = {
    ...metadata,
    photoCount: photoIds.length,
    manifest,
    failedPhotoIds: job.failedPhotoIds.slice(0, FAILED_PHOTO_SAMPLE_LIMIT),
    ...(job.failedPhotoIdsTruncated ||
    job.failedPhotoIds.length > FAILED_PHOTO_SAMPLE_LIMIT
      ? { failedPhotoIdsTruncated: true }
      : {}),
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 64000) throw invalid();
  return result;
}
export function decodeJobRow(row: {
  $id: string;
  [key: string]: unknown;
}): JobEnvelope {
  let job: JobEnvelope;
  try {
    job = JSON.parse(String(row.payload)) as JobEnvelope;
  } catch {
    throw invalid();
  }
  if (
    !job ||
    job.id !== row.$id ||
    job.ownerId !== row.ownerId ||
    job.eventId !== row.eventId ||
    job.status !== row.status ||
    job.availableAt !== row.availableAt
  )
    throw invalid();
  const format = shape(job);
  if (hasManifest(job)) {
    if (
      job.manifest?.version !== format.version ||
      !Number.isInteger(job.photoCount) ||
      job.photoCount < 1 ||
      job.photoCount > MAX_JOB_PHOTOS ||
      job.manifest.parts !== Math.ceil(job.photoCount / format.partSize) ||
      !/^[a-f0-9]{64}$/.test(job.manifest.digest)
    )
      throw invalid();
  } else if (
    !Array.isArray(job.photoIds) ||
    !job.photoIds.length ||
    job.photoIds.length > MAX_JOB_PHOTOS ||
    job.photoIds.some((id) => !format.validId(id))
  )
    throw invalid();
  return job;
}
export function summarizeJob(job: JobEnvelope): JobListEntry {
  if (hasManifest(job)) return { ...job };
  const { photoIds, retryUncertainPhotoIds: _retryIds, ...metadata } = job;
  void _retryIds;
  return { ...metadata, photoCount: photoIds.length };
}
export function decodeManifest(
  job: ManifestJob,
  rows: ManifestRow[],
): ManifestContents {
  const format = shape(job);
  if (
    job.manifest.version !== format.version ||
    rows.length !== job.manifest.parts
  )
    throw invalid();
  const photoIds: string[] = [],
    retryUncertainPhotoIds: string[] = [];
  const sorted = [...rows].sort(
    (a, b) => Number(a.partIndex) - Number(b.partIndex),
  );
  for (const [index, row] of sorted.entries()) {
    if (
      row.$id !== manifestPartId(job.id, index) ||
      row.ownerId !== job.ownerId ||
      row.jobId !== job.id ||
      row.partIndex !== index
    )
      throw invalid();
    let part: {
      version: number;
      ownerId: string;
      eventId: string;
      jobId: string;
      index: number;
      photoIds: string[];
      retryUncertainPhotoIds: string[];
    };
    try {
      part = JSON.parse(String(row.payload)) as typeof part;
    } catch {
      throw invalid();
    }
    if (
      !part ||
      part.version !== format.version ||
      part.ownerId !== job.ownerId ||
      part.eventId !== job.eventId ||
      part.jobId !== job.id ||
      part.index !== index ||
      !Array.isArray(part.photoIds) ||
      !part.photoIds.length ||
      part.photoIds.length > format.partSize ||
      part.photoIds.some((id) => !format.validId(id)) ||
      !Array.isArray(part.retryUncertainPhotoIds) ||
      (job.type === 'cloud-import' && part.retryUncertainPhotoIds.length > 0) ||
      part.retryUncertainPhotoIds.some((id) => !part.photoIds.includes(id))
    )
      throw invalid();
    photoIds.push(...part.photoIds);
    retryUncertainPhotoIds.push(...part.retryUncertainPhotoIds);
  }
  retryUncertainPhotoIds.sort();
  const result = { photoIds, retryUncertainPhotoIds };
  if (
    photoIds.length !== job.photoCount ||
    new Set(photoIds).size !== photoIds.length ||
    new Set(retryUncertainPhotoIds).size !== retryUncertainPhotoIds.length ||
    digest(result) !== job.manifest.digest
  )
    throw invalid();
  return result;
}
