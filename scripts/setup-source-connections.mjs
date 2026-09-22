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
      `Connection setup ${method} ${path}: HTTP ${response.status}, ${data.type ?? 'unknown error'}`,
    );
  }
  return response.status === 204 ? null : response.json();
}
const db = '/tablesdb/picfind-library';
if (!(await call(db)))
  throw new Error('Run npm run setup before provisioning processing jobs.');
const base = `${db}/tables/source-connections`;
if (!(await call(base)))
  await call(`${db}/tables`, 'POST', {
    tableId: 'source-connections',
    name: 'Private encrypted cloud connections',
    permissions: [],
    rowSecurity: true,
  });
for (const [key, size] of [
  ['ownerId', 64],
  ['provider', 16],
  ['payload', 64000],
]) {
  if (!(await call(`${base}/columns/${key}`)))
    await call(`${base}/columns/string`, 'POST', { key, size, required: true });
}
for (let attempt = 0; attempt < 30; attempt++) {
  const { columns } = await call(`${base}/columns`);
  const required = ['ownerId', 'provider', 'payload'];
  if (
    columns.some(
      (column) =>
        required.includes(column.key) &&
        ['failed', 'stuck'].includes(column.status),
    )
  )
    throw new Error('Connection columns failed to initialize.');
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
      'Connection columns are still provisioning. Run this setup again shortly.',
    );
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const table = await call(base);
if (!table?.rowSecurity || table?.$permissions?.length)
  throw new Error(
    'Cloud connections must use row security with no public table permissions. Fix permissions before enabling this feature.',
  );
console.info(
  'Private cloud connection table provisioned. No OAuth, AWS or payment calls. Set SOURCE_CONNECTIONS_ENABLED=true and keep SOURCE_COOKIE_KEY stable before restarting.',
);
