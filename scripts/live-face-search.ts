/**
 * Opt-in live Rekognition search. Disabled unless AWS_REKOGNITION_LIVE_TEST=1.
 * Indexes one Drive folder page or a JSON list of file ids, then searches a local selfie.
 */
import { loadEnvFile } from 'node:process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { RekognitionFaceMatchingProvider } from '../apps/api/src/adapters/rekognition.ts';
import {
  downloadDriveFile,
  listDriveImages,
  parseDriveFolderId,
} from '../apps/api/src/drive.ts';

try {
  loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch {
  /* local env is optional when the shell already has credentials */
}

if (process.env.AWS_REKOGNITION_LIVE_TEST !== '1') {
  console.error(
    'Refusing to run. Set AWS_REKOGNITION_LIVE_TEST=1 to make paid Rekognition calls.',
  );
  process.exit(2);
}

const source = process.argv[2];
const selfiePath = process.argv[3];
if (!source || !selfiePath) {
  console.error(
    'Usage: AWS_REKOGNITION_LIVE_TEST=1 npx tsx scripts/live-face-search.ts <drive-folder-url|ids.json> <selfie-path>',
  );
  process.exit(2);
}

const region = process.env.AWS_REGION;
const threshold = Number(process.env.REKOGNITION_MATCH_THRESHOLD ?? 80);
const driveKey = process.env.GOOGLE_DRIVE_API_KEY;
const driveToken = process.env.GOOGLE_DRIVE_ACCESS_TOKEN;
const maxPhotos = Number(process.env.FACE_INDEX_MAX ?? 20);
if (!region || !Number.isFinite(threshold)) {
  console.error('Need AWS_REGION and a numeric REKOGNITION_MATCH_THRESHOLD.');
  process.exit(1);
}

async function optimize(input: Buffer) {
  const output = await sharp(input, {
    limitInputPixels: 40_000_000,
    failOn: 'error',
    animated: false,
  })
    .rotate()
    .resize({
      width: 1600,
      height: 1600,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer();
  if (output.length > 5 * 1024 * 1024)
    throw new Error('too large after optimize');
  return output;
}

async function candidates() {
  if (source.endsWith('.json')) {
    return (
      JSON.parse((await readFile(source, 'utf8')).replace(/^\uFEFF/, '')) as {
        id: string;
        name: string;
      }[]
    ).slice(0, maxPhotos);
  }
  const credentials = driveToken
    ? { accessToken: driveToken }
    : driveKey
      ? { apiKey: driveKey }
      : undefined;
  if (!credentials)
    throw new Error(
      'Set GOOGLE_DRIVE_ACCESS_TOKEN (user OAuth) or GOOGLE_DRIVE_API_KEY for folder URLs. Cursor Drive MCP cannot be used by this script.',
    );
  return listDriveImages(credentials, parseDriveFolderId(source), maxPhotos);
}

async function download(file: { id: string; name: string }) {
  const credentials = driveToken
    ? { accessToken: driveToken }
    : driveKey
      ? { apiKey: driveKey }
      : undefined;
  if (credentials) return downloadDriveFile(credentials, file.id);
  const response = await fetch(
    `https://drive.usercontent.google.com/download?id=${encodeURIComponent(file.id)}&export=download&confirm=t`,
    { redirect: 'follow', signal: AbortSignal.timeout(90_000) },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.subarray(0, 20).toString('utf8').toLowerCase().includes('<html'))
    throw new Error('html interstitial');
  return buffer;
}

const files = await candidates();
console.info(
  `About to index ${files.length} photo(s) (cap ${maxPhotos}) and search 1 reference image in ${region} at threshold ${threshold}.`,
);

const matcher = new RekognitionFaceMatchingProvider(
  {
    region,
    namespace: process.env.REKOGNITION_NAMESPACE ?? 'picfind-dev',
    matchThreshold: threshold,
    maxMatches: Number(process.env.REKOGNITION_MAX_MATCHES ?? 50),
  },
  async () => {},
);
const scope = { kind: 'scan' as const, id: 'livetest001' };
const map = new Map<string, string>();
let indexed = 0;
try {
  await matcher.ensureScope(scope);
  for (const file of files) {
    try {
      const processed = await optimize(await download(file));
      const photoId = createHash('sha256')
        .update(file.id)
        .digest('hex')
        .slice(0, 32);
      const result = await matcher.indexPhoto({
        scope,
        photoId,
        bytes: processed,
        consentRecordId: 'livetestconsent01',
      });
      map.set(result.externalImageId, file.name);
      processed.fill(0);
      indexed += 1;
      console.info(`indexed ${file.name}: ${result.faceIds.length} face(s)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed';
      console.info(`skipped ${file.name}: ${message}`);
    }
  }
  const selfie = await optimize(await readFile(selfiePath));
  const search = await matcher.search({
    scope,
    bytes: selfie,
    consentRecordId: 'livetestconsent01',
  });
  selfie.fill(0);
  console.info(`indexed_ok ${indexed} model ${search.modelVersion}`);
  if (!search.matches.length)
    console.info('No matches at the configured threshold.');
  for (const match of search.matches) {
    console.info(
      `${match.similarity.toFixed(1)}  ${map.get(match.externalImageId) ?? match.externalImageId}`,
    );
  }
} finally {
  try {
    await matcher.deleteScope(scope);
    console.info('Deleted live test collection.');
  } catch (error) {
    console.info(
      `Could not delete the live test collection: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }
}
