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
  if (method === 'GET' && response.status === 404) return null;
  if (method === 'POST' && response.status === 409) return null;
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(
      `Job setup ${method} ${path}: HTTP ${response.status}, ${data.type ?? 'unknown error'}`,
    );
  }
  return response.status === 204 ? null : response.json();
}
const db = '/tablesdb/picfind-library';
if (!(await call(db)))
  throw new Error('Run npm run setup before provisioning processing jobs.');
const base = `${db}/tables/processing-jobs`;
if (!(await call(base)))
  await call(`${db}/tables`, 'POST', {
    tableId: 'processing-jobs',
    name: 'Private processing jobs',
    permissions: [],
    rowSecurity: true,
  });
for (const [key, size] of [
  ['ownerId', 64],
  ['eventId', 64],
  ['status', 20],
  ['availableAt', 32],
  ['payload', 64000],
]) {
  if (!(await call(`${base}/columns/${key}`)))
    await call(`${base}/columns/string`, 'POST', { key, size, required: true });
}
for (let attempt = 0; attempt < 30; attempt++) {
  const { columns } = await call(`${base}/columns`);
  const required = ['ownerId', 'eventId', 'status', 'availableAt', 'payload'];
  if (
    columns.some(
      (column) =>
        required.includes(column.key) &&
        ['failed', 'stuck'].includes(column.status),
    )
  )
    throw new Error('Job columns failed to initialize.');
  if (
    required.every((key) =>
      columns.some(
        (column) => column.key === key && column.status === 'available',
      ),
    )
  )
    break;
  if (attempt === 29)
    throw new Error(
      'Job columns are still provisioning. Run this setup again shortly.',
    );
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
for (const index of [
  { key: 'status_due', columns: ['status', 'availableAt'] },
  { key: 'owner', columns: ['ownerId'] },
  { key: 'owner_event', columns: ['ownerId', 'eventId'] },
]) {
  if (!(await call(`${base}/indexes/${index.key}`)))
    await call(`${base}/indexes`, 'POST', {
      ...index,
      type: 'key',
      orders: index.columns.map(() => 'ASC'),
    });
}
const manifests = `${db}/tables/processing-manifests`;
if (!(await call(manifests)))
  await call(`${db}/tables`, 'POST', {
    tableId: 'processing-manifests',
    name: 'Private immutable processing snapshots',
    permissions: [],
    rowSecurity: true,
  });
for (const [key, size] of [
  ['ownerId', 64],
  ['jobId', 36],
  ['payload', 64000],
]) {
  if (!(await call(`${manifests}/columns/${key}`)))
    await call(`${manifests}/columns/string`, 'POST', {
      key,
      size,
      required: true,
    });
}
if (!(await call(`${manifests}/columns/partIndex`)))
  await call(`${manifests}/columns/integer`, 'POST', {
    key: 'partIndex',
    required: true,
    min: 0,
    max: 24,
  });
for (let attempt = 0; attempt < 30; attempt++) {
  const { columns } = await call(`${manifests}/columns`);
  const required = ['ownerId', 'jobId', 'partIndex', 'payload'];
  if (
    columns.some(
      (column) =>
        required.includes(column.key) &&
        ['failed', 'stuck'].includes(column.status),
    )
  )
    throw new Error('Manifest columns failed to initialize.');
  if (
    required.every((key) =>
      columns.some(
        (column) => column.key === key && column.status === 'available',
      ),
    )
  )
    break;
  if (attempt === 29)
    throw new Error(
      'Manifest columns are still provisioning. Run setup again shortly.',
    );
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
for (const index of [
  { key: 'owner_job', columns: ['ownerId', 'jobId', 'partIndex'] },
  { key: 'job', columns: ['jobId'] },
]) {
  if (!(await call(`${manifests}/indexes/${index.key}`)))
    await call(`${manifests}/indexes`, 'POST', {
      ...index,
      type: 'key',
      orders: index.columns.map(() => 'ASC'),
    });
}
console.info(
  'Private job and manifest tables provisioned. No photos processed and no Rekognition calls.',
);
