import type {
  FaceMatchingProvider,
  Scope,
} from '../../../packages/shared/src/ports.js';
import {
  RekognitionFaceMatchingProvider,
  type FaceAction,
} from './adapters/rekognition.js';
import type { environmentSchema } from './config.js';
import { z } from 'zod';

type Config = z.infer<typeof environmentSchema>;

async function authorize(
  _scope: Scope,
  _action: FaceAction,
  consentRecordId?: string,
) {
  if ((_action === 'index' || _action === 'search') && !consentRecordId)
    throw new Error('FACE_CONSENT_REQUIRED');
}

export async function createFaceMatcher(
  config: Config,
): Promise<FaceMatchingProvider | undefined> {
  if (config.FACE_PROVIDER !== 'aws-rekognition') return undefined;
  if (config.REKOGNITION_MATCH_THRESHOLD === undefined)
    throw new Error('REKOGNITION_MATCH_THRESHOLD is required.');
  const matcher = new RekognitionFaceMatchingProvider(
    {
      region: config.AWS_REGION,
      namespace: config.REKOGNITION_NAMESPACE,
      matchThreshold: config.REKOGNITION_MATCH_THRESHOLD,
      maxMatches: config.REKOGNITION_MAX_MATCHES,
    },
    authorize,
  );
  try {
    await matcher.healthCheck();
  } catch {
    console.error(
      'FACE_PROVIDER=aws-rekognition is selected but Rekognition is not callable yet. Face matching stays off until the PicFind IAM user can ListCollections.',
    );
    return undefined;
  }
  return matcher;
}
