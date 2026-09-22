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
const base = '/tablesdb/picfind-library/tables/billing';
async function call(path, method = 'GET', body) {
  const res = await fetch(`${endpoint.replace(/\/$/, '')}${path}`, {
    method,
    headers: {
      'X-Appwrite-Project': project,
      'X-Appwrite-Key': key,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 409) return null;
  if (res.status === 404 && method === 'GET') return null;
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      `Billing setup: HTTP ${res.status}, ${data.type ?? 'unknown'}. Ensure library setup and TablesDB scopes are enabled.`,
    );
  }
  return res.status === 204 ? null : res.json();
}
if (!(await call(base)))
  await call('/tablesdb/picfind-library/tables', 'POST', {
    tableId: 'billing',
    name: 'Private billing ledger',
    permissions: [],
    rowSecurity: true,
  });
for (const [key, size] of [
  ['ownerId', 64],
  ['kind', 20],
  ['payload', 16000],
])
  if (!(await call(`${base}/columns/${key}`)))
    await call(`${base}/columns/string`, 'POST', { key, size, required: true });
for (let attempt = 0; attempt < 30; attempt++) {
  const result = await call(`${base}/columns`);
  if (
    result.columns.some((column) => ['failed', 'stuck'].includes(column.status))
  )
    throw new Error('Billing columns failed to provision.');
  if (
    ['ownerId', 'kind', 'payload'].every((key) =>
      result.columns.some(
        (column) => column.key === key && column.status === 'available',
      ),
    )
  )
    break;
  if (attempt === 29)
    throw new Error(
      'Billing columns are still provisioning. Run setup again shortly.',
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
if (!(await call(`${base}/indexes/billing_kind`)))
  await call(`${base}/indexes`, 'POST', {
    key: 'billing_kind',
    type: 'key',
    columns: ['kind'],
    orders: ['ASC'],
  });
console.info(
  'Private billing table provisioned. Checkout remains disabled until explicitly activated. No AWS or payment calls.',
);
