import { describe, expect, it, vi } from 'vitest';
import { RekognitionClient } from '@aws-sdk/client-rekognition';
import { RekognitionFaceMatchingProvider } from '../../apps/api/src/adapters/rekognition';

const bytes = () => new Uint8Array([255, 216, 255, 1, 2, 3, 4, 5]);
const scope = { kind: 'event' as const, id: 'event-a' };
const config = {
  region: 'ap-south-1',
  namespace: 'picfind-test',
  matchThreshold: 97,
  maxMatches: 2,
};
function setup() {
  const send = vi.fn();
  const authorize = vi.fn(async () => {});
  const provider = new RekognitionFaceMatchingProvider(config, authorize, {
    send,
  } as unknown as Pick<RekognitionClient, 'send'>);
  return { send, authorize, provider };
}

describe('Rekognition transport adapter', () => {
  it('rejects a missing threshold instead of using the AWS default', () => {
    expect(
      () =>
        new RekognitionFaceMatchingProvider(
          { ...config, matchThreshold: Number.NaN },
          async () => {},
        ),
    ).toThrow();
  });
  it('does not call AWS after authorization is denied', async () => {
    const { provider, send, authorize } = setup();
    authorize.mockRejectedValueOnce(new Error('DENIED'));
    await expect(
      provider.search({ scope, bytes: bytes(), consentRecordId: 'consent-a' }),
    ).rejects.toThrow('DENIED');
    expect(send).not.toHaveBeenCalled();
  });
  it('keeps event and scan collections isolated', async () => {
    const { provider, send } = setup();
    send.mockResolvedValue({ FaceModelVersion: '7.0' });
    await provider.ensureScope(scope);
    await provider.ensureScope({ ...scope, id: 'event-b' });
    await provider.ensureScope({ kind: 'scan', id: scope.id });
    const ids = send.mock.calls.map((call) => call[0].input.CollectionId);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toMatch(/^picfind-test-event-[a-f0-9]{64}$/);
  });
  it.each([0, 2])(
    'rejects %i detected reference faces without searching',
    async (count) => {
      const { provider, send } = setup();
      send.mockResolvedValueOnce({
        FaceDetails: Array.from({ length: count }, () => ({})),
      });
      await expect(
        provider.search({
          scope,
          bytes: bytes(),
          consentRecordId: 'consent-a',
        }),
      ).rejects.toThrow(
        count === 0 ? 'REFERENCE_NO_FACE' : 'REFERENCE_MULTIPLE_FACES',
      );
      expect(send).toHaveBeenCalledTimes(1);
    },
  );
  it('passes configured scores, flags capped results and never indexes a selfie', async () => {
    const { provider, send, authorize } = setup();
    send.mockResolvedValueOnce({ FaceDetails: [{}] }).mockResolvedValueOnce({
      FaceModelVersion: '7.0',
      FaceMatches: [
        {
          Face: { FaceId: 'face-a', ExternalImageId: 'photo-a' },
          Similarity: 99,
        },
        {
          Face: { FaceId: 'face-b', ExternalImageId: 'photo-b' },
          Similarity: 98,
        },
      ],
    });
    const original = bytes();
    const result = await provider.search({
      scope,
      bytes: original,
      consentRecordId: 'consent-a',
    });
    expect(result.limitReached).toBe(true);
    expect(authorize).toHaveBeenCalledWith(scope, 'search', 'consent-a');
    expect(send.mock.calls[1]![0].constructor.name).toBe(
      'SearchFacesByImageCommand',
    );
    expect(send.mock.calls[1]![0].input).toMatchObject({
      FaceMatchThreshold: 97,
      MaxFaces: 2,
    });
    expect([...send.mock.calls[1]![0].input.Image.Bytes]).toEqual(
      Array(8).fill(0),
    );
    expect(original).toEqual(bytes());
  });
  it('keeps retry image identifiers stable and exposes partial indexing', async () => {
    const { provider, send } = setup();
    send.mockResolvedValue({
      FaceModelVersion: '7.0',
      FaceRecords: [],
      UnindexedFaces: [{ Reasons: ['LOW_SHARPNESS'] }],
    });
    const input = {
      scope,
      bytes: bytes(),
      photoId: 'photo-a',
      consentRecordId: 'consent-a',
    };
    const first = await provider.indexPhoto(input);
    const second = await provider.indexPhoto(input);
    expect(first.externalImageId).toBe(second.externalImageId);
    expect(first.unindexedReasons).toEqual([['LOW_SHARPNESS']]);
    expect(send.mock.calls[0]![0].input.DetectionAttributes).toEqual([
      'DEFAULT',
    ]);
  });
  it('rejects unsupported image bytes before AWS processing', async () => {
    const { provider, send } = setup();
    await expect(
      provider.search({
        scope,
        bytes: new Uint8Array(8),
        consentRecordId: 'consent-a',
      }),
    ).rejects.toThrow('FACE_IMAGE_FORMAT_INVALID');
    expect(send).not.toHaveBeenCalled();
  });
  it('does not call a partial deletion successful', async () => {
    const { provider, send } = setup();
    send.mockResolvedValue({
      UnsuccessfulFaceDeletions: [
        { Reasons: ['ASSOCIATED_TO_AN_EXISTING_USER'] },
      ],
    });
    await expect(
      provider.deleteFaces(scope, ['00000000-0000-4000-8000-000000000001']),
    ).rejects.toThrow('FACE_DELETION_INCOMPLETE');
  });
});
