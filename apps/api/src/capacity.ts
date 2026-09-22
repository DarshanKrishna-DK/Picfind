import { MAX_JOB_PHOTOS } from './job-manifest.js';

export function libraryCapacity(
  options: { faceIndexMax?: number; eventIndexMax?: number } = {},
  mode = process.env.NODE_ENV,
) {
  const production = mode === 'production';
  const configured =
    options.eventIndexMax ??
    (process.env.EVENT_INDEX_MAX
      ? Number(process.env.EVENT_INDEX_MAX)
      : undefined);
  if (
    configured !== undefined &&
    (!Number.isInteger(configured) ||
      configured < 1 ||
      configured > MAX_JOB_PHOTOS)
  )
    throw new Error(
      'EVENT_INDEX_MAX must be an integer from 1 to ' + MAX_JOB_PHOTOS + '.',
    );
  const discover = options.faceIndexMax ?? 20;
  if (!Number.isInteger(discover) || discover < 1 || discover > 100)
    throw new Error('Discover processing batch must contain 1 to 100 photos.');
  return {
    production,
    libraryPhotos: production ? 25_000 : 20,
    events: production ? 1000 : 20,
    eventPhotos: production
      ? (configured ?? MAX_JOB_PHOTOS)
      : Math.min(20, configured ?? discover),
    discoverPhotos: Math.min(production ? 100 : 20, discover),
  };
}
