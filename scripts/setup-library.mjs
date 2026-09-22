import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
const {
  APPWRITE_ENDPOINT: endpoint,
  APPWRITE_PROJECT_ID: project,
  APPWRITE_API_KEY: key,
} = process.env;
if (!endpoint || !project || !key)
  throw new Error('Appwrite configuration is required.');
async function call(path, method = 'GET', body) {
  const response = await fetch(`${endpoint.replace(/\/$/, '')}${path}`, {
    method,
    headers: {
      'X-Appwrite-Project': project,
      'X-Appwrite-Key': key,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  if (response.status === 409) return null;
  if (response.status === 404 && method === 'GET') return null;
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(
      `Appwrite setup ${method} ${path}: HTTP ${response.status}, ${data.type ?? 'unknown error'}`,
    );
  }
  return response.status === 204 ? null : response.json();
}
// Check before creation: free-tier quota checks may run before duplicate-ID checks.
const existingDatabase = await fetch(
  `${endpoint.replace(/\/$/, '')}/tablesdb/picfind-library`,
  {
    headers: { 'X-Appwrite-Project': project, 'X-Appwrite-Key': key },
    signal: AbortSignal.timeout(20000),
  },
);
if (existingDatabase.status === 404)
  await call('/tablesdb', 'POST', {
    databaseId: 'picfind-library',
    name: 'PicFind library',
  });
else if (!existingDatabase.ok)
  throw new Error(`Appwrite database access: HTTP ${existingDatabase.status}`);
if (!(await call('/tablesdb/picfind-library/tables/records')))
  await call('/tablesdb/picfind-library/tables', 'POST', {
    tableId: 'records',
    name: 'Library records',
    permissions: [],
    rowSecurity: true,
  });
const base = '/tablesdb/picfind-library/tables/records';
for (const [key, size] of [
  ['ownerId', 36],
  ['kind', 20],
  ['payload', 16000],
])
  if (!(await call(`${base}/columns/${key}`)))
    await call(`${base}/columns/string`, 'POST', { key, size, required: true });
if (!(await call(`${base}/columns/purgeAt`)))
  await call(`${base}/columns/datetime`, 'POST', {
    key: 'purgeAt',
    required: false,
  });
for (let attempt = 0; attempt < 20; attempt++) {
  const result = await call(`${base}/columns`);
  if (
    result.columns.some((column) => ['failed', 'stuck'].includes(column.status))
  )
    throw new Error('Appwrite columns failed to initialize.');
  if (
    ['ownerId', 'kind', 'payload', 'purgeAt'].every((key) =>
      result.columns.some(
        (column) => column.key === key && column.status === 'available',
      ),
    )
  )
    break;
  if (attempt === 19)
    throw new Error(
      'Appwrite attributes are still provisioning. Run setup again shortly.',
    );
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!(await call(`${base}/indexes/owner_kind`)))
  await call(`${base}/indexes`, 'POST', {
    key: 'owner_kind',
    type: 'key',
    columns: ['ownerId', 'kind'],
    orders: ['ASC', 'ASC'],
  });
if (!(await call(`${base}/indexes/kind_purge`)))
  await call(`${base}/indexes`, 'POST', {
    key: 'kind_purge',
    type: 'key',
    columns: ['kind', 'purgeAt'],
    orders: ['ASC', 'ASC'],
  });
if (!(await call('/storage/buckets/picfind-photos')))
  await call('/storage/buckets', 'POST', {
    bucketId: 'picfind-photos',
    name: 'PicFind private photos',
    permissions: [],
    fileSecurity: true,
    enabled: true,
    maximumFileSize: 4194304,
    allowedFileExtensions: ['jpg'],
    compression: 'none',
    encryption: true,
    antivirus: true,
  });
console.info(
  'PicFind library resources provisioned. Server-only permissions; no AWS calls.',
);
