import { createHash } from 'node:crypto';
import sharp, { type OutputInfo } from 'sharp';
import { ApiError } from './auth.js';

export const MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export async function processPhotoBytes(input: Buffer): Promise<{
  data: Buffer;
  info: OutputInfo;
  digest: string;
}> {
  if (!input.length || input.length > MAX_INPUT_BYTES)
    throw new ApiError(
      413,
      'FILE_TOO_LARGE',
      'Choose a photo smaller than 8 MB.',
    );
  try {
    const image = sharp(input, {
      limitInputPixels: 40_000_000,
      failOn: 'error',
      animated: false,
    });
    const metadata = await image.metadata();
    if (
      !['jpeg', 'png', 'webp'].includes(metadata.format ?? '') ||
      (metadata.pages ?? 1) > 1
    )
      throw new Error('unsupported');
    const output = await image
      .rotate()
      .resize({
        width: 3200,
        height: 3200,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 86, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    if (output.data.length > MAX_OUTPUT_BYTES)
      throw new ApiError(
        413,
        'FILE_TOO_LARGE',
        'The optimized image is too large. Please resize it first.',
      );
    return {
      data: output.data,
      info: output.info,
      digest: createHash('sha256').update(output.data).digest('hex'),
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      400,
      'INVALID_IMAGE',
      'Choose a readable, single-frame JPEG, PNG, or WebP image under 40 megapixels.',
    );
  }
}

export function safeFilename(filename: string) {
  return Array.from(filename, (character) =>
    character.charCodeAt(0) < 32 ||
    character.charCodeAt(0) === 127 ||
    '/\\'.includes(character)
      ? '_'
      : character,
  )
    .join('')
    .slice(0, 200);
}
