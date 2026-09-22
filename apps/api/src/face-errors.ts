import { ApiError } from './auth.js';

export function mapFaceError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const code = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  if (message === 'REFERENCE_NO_FACE')
    throw new ApiError(
      400,
      'NO_FACE',
      'No face was found in the reference photo. Use a clear, front-facing selfie.',
    );
  if (message === 'REFERENCE_MULTIPLE_FACES')
    throw new ApiError(
      400,
      'MULTIPLE_FACES',
      'The reference photo must contain exactly one face.',
    );
  if (
    message === 'FACE_IMAGE_SIZE_INVALID' ||
    message === 'FACE_IMAGE_FORMAT_INVALID'
  )
    throw new ApiError(
      400,
      'INVALID_IMAGE',
      'The reference photo must be a JPEG or PNG under 5 MB after processing.',
    );
  if (code === 'InvalidParameterException')
    throw new ApiError(
      400,
      'NO_FACE',
      'No searchable face was found in the reference photo.',
    );
  if (code === 'TimeoutError' || code === 'TimeoutException')
    throw new ApiError(
      504,
      'PROVIDER_TIMEOUT',
      'Face matching timed out. Please try again.',
    );
  if (
    code === 'ThrottlingException' ||
    code === 'ProvisionedThroughputExceededException'
  )
    throw new ApiError(
      429,
      'RATE_LIMIT',
      'Too many face matching requests. Please wait and try again.',
    );
  throw new ApiError(
    503,
    'FACE_PROVIDER_UNAVAILABLE',
    'Face matching is temporarily unavailable.',
  );
}

export function requireMatcher<T>(matcher: T | undefined): T {
  if (!matcher)
    throw new ApiError(
      503,
      'FACE_MATCHING_UNAVAILABLE',
      'Face matching is not configured. An organizer can still share a full gallery.',
    );
  return matcher;
}
