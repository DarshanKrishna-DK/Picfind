import { createHash } from 'node:crypto';
import {
  CreateCollectionCommand,
  DeleteCollectionCommand,
  DeleteFacesCommand,
  DescribeCollectionCommand,
  DetectFacesCommand,
  IndexFacesCommand,
  ListCollectionsCommand,
  RekognitionClient,
  SearchFacesByImageCommand,
} from '@aws-sdk/client-rekognition';
import { z } from 'zod';
import type {
  FaceMatchingProvider,
  Scope,
} from '../../../../packages/shared/src/ports.js';

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const scopeSchema = z.object({
  kind: z.enum(['event', 'scan']),
  id: identifier,
});
const configSchema = z.object({
  region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/),
  namespace: z.string().regex(/^picfind-[a-z0-9-]{1,40}$/),
  matchThreshold: z.number().finite().min(0).max(100),
  maxMatches: z.number().int().min(1).max(4096),
});
export type RekognitionConfig = z.infer<typeof configSchema>;
export type FaceAction = 'create' | 'index' | 'search' | 'delete';
export type AuthorizeFaceOperation = (
  scope: Scope,
  action: FaceAction,
  consentRecordId?: string,
) => Promise<void>;

function digest(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex');
}

function checkedImage(bytes: Uint8Array) {
  if (bytes.length < 8 || bytes.length > 5 * 1024 * 1024)
    throw new Error('FACE_IMAGE_SIZE_INVALID');
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b);
  if (!jpeg && !png) throw new Error('FACE_IMAGE_FORMAT_INVALID');
  return Uint8Array.from(bytes);
}

function modelVersion(value: string | undefined) {
  if (!value) throw new Error('FACE_PROVIDER_MODEL_VERSION_MISSING');
  return value;
}

export class RekognitionFaceMatchingProvider implements FaceMatchingProvider {
  private readonly config: RekognitionConfig;
  private readonly client: Pick<RekognitionClient, 'send'>;

  constructor(
    config: RekognitionConfig,
    private readonly authorize: AuthorizeFaceOperation,
    client?: Pick<RekognitionClient, 'send'>,
  ) {
    this.config = configSchema.parse(config);
    this.client =
      client ??
      new RekognitionClient({
        region: this.config.region,
        maxAttempts: 3,
      });
  }

  private collection(scope: Scope) {
    const valid = scopeSchema.parse(scope);
    return `${this.config.namespace}-${valid.kind}-${digest(valid.id)}`;
  }

  async healthCheck() {
    await this.client.send(new ListCollectionsCommand({ MaxResults: 1 }));
  }

  async ensureScope(scope: Scope) {
    const CollectionId = this.collection(scope);
    await this.authorize(scope, 'create');
    try {
      const result = await this.client.send(
        new DescribeCollectionCommand({ CollectionId }),
      );
      return { modelVersion: modelVersion(result.FaceModelVersion) };
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== 'ResourceNotFoundException'
      )
        throw error;
    }
    try {
      const result = await this.client.send(
        new CreateCollectionCommand({ CollectionId }),
      );
      return { modelVersion: modelVersion(result.FaceModelVersion) };
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== 'ResourceAlreadyExistsException'
      )
        throw error;
      const result = await this.client.send(
        new DescribeCollectionCommand({ CollectionId }),
      );
      return { modelVersion: modelVersion(result.FaceModelVersion) };
    }
  }

  async indexPhoto(input: Parameters<FaceMatchingProvider['indexPhoto']>[0]) {
    const CollectionId = this.collection(input.scope);
    identifier.parse(input.photoId);
    identifier.parse(input.consentRecordId);
    await this.authorize(input.scope, 'index', input.consentRecordId);
    const Bytes = checkedImage(input.bytes);
    const externalImageId = digest(`${input.photoId}:${digest(Bytes)}`);
    try {
      const result = await this.client.send(
        new IndexFacesCommand({
          CollectionId,
          Image: { Bytes },
          ExternalImageId: externalImageId,
          DetectionAttributes: ['DEFAULT'],
          QualityFilter: 'AUTO',
          MaxFaces: 100,
        }),
      );
      const faceIds = (result.FaceRecords ?? []).map((record) => {
        if (!record.Face?.FaceId)
          throw new Error('FACE_PROVIDER_RESPONSE_INVALID');
        return record.Face.FaceId;
      });
      return {
        modelVersion: modelVersion(result.FaceModelVersion),
        externalImageId,
        faceIds,
        unindexedReasons: (result.UnindexedFaces ?? []).map(
          (face) => face.Reasons ?? ['UNKNOWN'],
        ),
      };
    } finally {
      Bytes.fill(0);
    }
  }

  async search(input: Parameters<FaceMatchingProvider['search']>[0]) {
    const CollectionId = this.collection(input.scope);
    identifier.parse(input.consentRecordId);
    await this.authorize(input.scope, 'search', input.consentRecordId);
    const Bytes = checkedImage(input.bytes);
    try {
      const detected = await this.client.send(
        new DetectFacesCommand({ Image: { Bytes }, Attributes: ['DEFAULT'] }),
      );
      const count = detected.FaceDetails?.length ?? 0;
      if (count === 0) throw new Error('REFERENCE_NO_FACE');
      if (count !== 1) throw new Error('REFERENCE_MULTIPLE_FACES');
      const result = await this.client.send(
        new SearchFacesByImageCommand({
          CollectionId,
          Image: { Bytes },
          FaceMatchThreshold: this.config.matchThreshold,
          MaxFaces: this.config.maxMatches,
          QualityFilter: 'NONE',
        }),
      );
      const matches = (result.FaceMatches ?? []).map((match) => {
        const { Face: face, Similarity: similarity } = match;
        if (
          !face?.FaceId ||
          !face.ExternalImageId ||
          similarity === undefined ||
          !Number.isFinite(similarity) ||
          similarity < 0 ||
          similarity > 100
        )
          throw new Error('FACE_PROVIDER_RESPONSE_INVALID');
        return {
          faceId: face.FaceId,
          externalImageId: face.ExternalImageId,
          similarity,
        };
      });
      return {
        modelVersion: modelVersion(result.FaceModelVersion),
        matches,
        limitReached: matches.length >= this.config.maxMatches,
      };
    } finally {
      Bytes.fill(0);
    }
  }

  async deleteFaces(scope: Scope, faceIds: string[]) {
    const CollectionId = this.collection(scope);
    z.array(z.string().uuid()).min(1).max(4096).parse(faceIds);
    await this.authorize(scope, 'delete');
    const result = await this.client.send(
      new DeleteFacesCommand({ CollectionId, FaceIds: faceIds }),
    );
    if ((result.UnsuccessfulFaceDeletions?.length ?? 0) > 0)
      throw new Error('FACE_DELETION_INCOMPLETE');
  }

  async deleteScope(scope: Scope) {
    const CollectionId = this.collection(scope);
    await this.authorize(scope, 'delete');
    try {
      await this.client.send(new DeleteCollectionCommand({ CollectionId }));
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== 'ResourceNotFoundException'
      )
        throw error;
    }
  }
}
