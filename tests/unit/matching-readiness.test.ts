import { describe, expect, it } from 'vitest';
import { matchingReadiness } from '../../apps/api/src/matching-readiness';
import type { LibraryRecord } from '../../apps/api/src/library';

const now = Date.parse('2026-10-20T12:00:00Z');
const event: LibraryRecord = {
  id: 'event',
  ownerId: 'owner',
  kind: 'event',
  createdAt: new Date(now).toISOString(),
  visibility: 'private',
};
const runtime = {
  provider: 'aws-rekognition' as const,
  processingAvailable: true,
  active: false,
};
const photo = (patch: Partial<LibraryRecord> = {}): LibraryRecord => ({
  ...event,
  id: 'photo',
  kind: 'photo',
  eventId: event.id,
  ...patch,
});
const prepared = photo({
  indexState: 'ready',
  provider: 'aws-rekognition',
  externalImageId: 'private-image-id',
  faceIds: ['private-face-id'],
  modelVersion: '7',
});

describe('event matching readiness metadata', () => {
  it('marks missing or mixed model metadata as requiring attention', () => {
    const missing = { ...prepared };
    delete missing.modelVersion;
    const unknown = matchingReadiness(event, [missing], runtime, now);
    expect(unknown.counts.needsReview).toBe(1);
    expect(unknown.status).toBe('needs-attention');
    const contradictory = matchingReadiness(
      event,
      [{ ...prepared, indexState: 'empty' }],
      runtime,
      now,
    );
    expect(contradictory.counts.needsReview).toBe(1);
    expect(contradictory.counts.noFaces).toBe(0);
    const mixed = matchingReadiness(
      event,
      [prepared, { ...prepared, id: 'other', modelVersion: '6' }],
      runtime,
      now,
    );
    expect(mixed.counts).toMatchObject({
      prepared: 0,
      needsReview: 2,
      total: 2,
    });
    expect(mixed.status).toBe('needs-attention');
    expect(mixed.models).toEqual([
      { version: '6', photos: 1 },
      { version: '7', photos: 1 },
    ]);
  });
  it('excludes other events, owners, scans, expired and deleting photographs', () => {
    const result = matchingReadiness(
      event,
      [
        prepared,
        photo({ eventId: 'other' }),
        photo({ ownerId: 'other' }),
        photo({ scanId: 'personal' }),
        photo({ expiresAt: new Date(now).toISOString() }),
        photo({ expiresAt: 'invalid' }),
        photo({ deletionStartedAt: new Date(now).toISOString() }),
        { ...event, eventId: event.id },
      ],
      runtime,
      now,
    );
    expect(result.counts).toEqual({
      total: 1,
      prepared: 1,
      noFaces: 0,
      waiting: 0,
      failed: 0,
      needsReview: 0,
    });
    expect(result.status).toBe('ready');
    expect(result.gallery).toBe('private');
    expect(JSON.stringify(result)).not.toMatch(/private-(face|image)-id/);
  });

  it('keeps exclusive counts and exposes uncertainty as a subset', () => {
    const result = matchingReadiness(
      event,
      [
        prepared,
        photo({
          indexState: 'empty',
          provider: 'aws-rekognition',
          modelVersion: '7',
        }),
        photo({ indexState: 'queued', provider: 'aws-rekognition' }),
        photo({ indexState: 'failed', provider: 'aws-rekognition' }),
        photo(),
        { ...prepared, externalImageId: '' },
        { ...prepared, provider: 'future-provider' },
      ],
      runtime,
      now,
    );
    expect(result.counts).toEqual({
      total: 7,
      prepared: 1,
      noFaces: 1,
      waiting: 2,
      failed: 1,
      needsReview: 2,
    });
    expect(result.uncertain).toBe(2);
    expect(result.models).toEqual([{ version: '7', photos: 2 }]);
    expect(result.status).toBe('needs-attention');
  });

  it.each([
    [[], 'empty'],
    [[photo()], 'not-prepared'],
    [[prepared, photo()], 'partial'],
    [[prepared], 'ready'],
    [
      [
        photo({
          indexState: 'empty',
          provider: 'aws-rekognition',
          modelVersion: '7',
        }),
      ],
      'no-faces',
    ],
  ] as const)('distinguishes preparation outcomes %#', (photos, status) => {
    expect(matchingReadiness(event, [...photos], runtime, now).status).toBe(
      status,
    );
  });

  it.each([
    [{ archived: true }, 'archived'],
    [{ expiresAt: new Date(now).toISOString() }, 'expired'],
    [{ expiresAt: 'invalid' }, 'expired'],
    [
      { deletionStartedAt: new Date(now).toISOString(), archived: true },
      'deleting',
    ],
  ] as const)(
    'closed galleries take priority over prepared photos %#',
    (patch, status) => {
      const result = matchingReadiness(
        { ...event, ...patch },
        [prepared],
        runtime,
        now,
      );
      expect(result.status).toBe(status);
      expect(result.gallery).toBe(status);
    },
  );

  it('does not present saved results as an available provider', () => {
    const result = matchingReadiness(
      event,
      [prepared],
      {
        ...runtime,
        provider: null,
        processingAvailable: false,
      },
      now,
    );
    expect(result.status).toBe('unavailable');
    expect(result.counts.prepared).toBe(1);
    expect(result.searchAvailable).toBe(false);
  });

  it('reports active work without labelling its uncertainty as a failure', () => {
    expect(
      matchingReadiness(
        event,
        [photo({ indexState: 'queued', provider: 'aws-rekognition' })],
        { ...runtime, active: true },
        now,
      ).status,
    ).toBe('processing');
  });

  it('keeps worker configuration separate from already prepared search', () => {
    const result = matchingReadiness(
      { ...event, visibility: 'link' },
      [prepared],
      {
        ...runtime,
        processingAvailable: false,
      },
      now,
    );
    expect(result.status).toBe('ready');
    expect(result.gallery).toBe('shared');
    expect(result.processingAvailable).toBe(false);
    expect(result.checkedAt).toBe(new Date(now).toISOString());
  });
});
