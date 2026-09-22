import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
const {
  APPWRITE_ENDPOINT: endpoint,
  APPWRITE_PROJECT_ID: project,
  APPWRITE_API_KEY: key,
} = process.env;
if (!endpoint || !project || !key)
  throw new Error('Server-side Appwrite configuration is required.');
async function call(path, method = 'GET', body) {
  const response = await fetch(`${endpoint.replace(/\/$/, '')}${path}`, {
    method,
    headers: {
      'X-Appwrite-Project': project,
      'X-Appwrite-Key': key,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  if ((response.status === 404 && method === 'GET') || response.status === 409)
    return null;
  if (!response.ok)
    throw new Error(
      `Folder sync setup ${method} ${path}: HTTP ${response.status}`,
    );
  return response.status === 204 ? null : response.json();
}
// This script provisions private metadata only. It does not enable a scheduler.
if (!(await call('/tablesdb/picfind-library')))
  throw new Error('Run the existing library setup before folder sync setup.');
for (const definition of [
  {
    id: 'folder-syncs',
    strings: [
      ['ownerId', 36],
      ['actorId', 36],
      ['eventId', 36],
      ['status', 20],
      ['payload', 65535],
    ],
    dates: ['nextRunAt'],
    indexes: [
      ['status_due', ['status', 'nextRunAt']],
      ['owner_event', ['ownerId', 'eventId']],
      ['actor_status', ['actorId', 'status']],
    ],
  },
  {
    id: 'folder-sync-files',
    strings: [
      ['ownerId', 36],
      ['syncId', 36],
    ],
    dates: [],
    indexes: [['owner_sync', ['ownerId', 'syncId']]],
  },
]) {
  const base = `/tablesdb/picfind-library/tables/${definition.id}`;
  const existing = await call(base);
  if (!existing)
    await call('/tablesdb/picfind-library/tables', 'POST', {
      tableId: definition.id,
      name: definition.id,
      permissions: [],
      rowSecurity: true,
    });
  else if (!existing.rowSecurity || existing.$permissions?.length)
    throw new Error(
      `Refusing to use non-private table ${definition.id}. Review its permissions.`,
    );
  for (const [name, size] of definition.strings) {
    const column = await call(`${base}/columns/${name}`);
    if (!column)
      await call(`${base}/columns/string`, 'POST', {
        key: name,
        size,
        required: true,
      });
    else if (
      column.type !== 'string' ||
      column.size < size ||
      column.required !== true
    )
      throw new Error(`Incompatible column ${definition.id}.${name}.`);
  }
  for (const name of definition.dates) {
    const column = await call(`${base}/columns/${name}`);
    if (!column)
      await call(`${base}/columns/datetime`, 'POST', {
        key: name,
        required: true,
      });
    else if (column.type !== 'datetime' || column.required !== true)
      throw new Error(`Incompatible column ${definition.id}.${name}.`);
  }
  const names = [
    ...definition.strings.map(([name]) => name),
    ...definition.dates,
  ];
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await call(`${base}/columns`);
    if (
      result.columns.some((column) =>
        ['failed', 'stuck'].includes(column.status),
      )
    )
      throw new Error(`Column provisioning failed for ${definition.id}.`);
    if (
      names.every((name) =>
        result.columns.some(
          (column) => column.key === name && column.status === 'available',
        ),
      )
    )
      break;
    if (attempt === 19)
      throw new Error(
        `Columns for ${definition.id} are still provisioning. Run setup again later.`,
      );
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  for (const [name, columns] of definition.indexes) {
    const index = await call(`${base}/indexes/${name}`);
    if (!index)
      await call(`${base}/indexes`, 'POST', {
        key: name,
        type: 'key',
        columns,
        orders: columns.map(() => 'ASC'),
      });
    else if (
      index.type !== 'key' ||
      JSON.stringify(index.columns) !== JSON.stringify(columns)
    )
      throw new Error(`Incompatible index ${definition.id}.${name}.`);
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await call(`${base}/indexes`);
    const expected = definition.indexes.map(([name]) => name);
    if (
      result.indexes.some(
        (index) =>
          expected.includes(index.key) &&
          ['failed', 'stuck'].includes(index.status),
      )
    )
      throw new Error(`Index provisioning failed for ${definition.id}.`);
    if (
      expected.every((name) =>
        result.indexes.some(
          (index) => index.key === name && index.status === 'available',
        ),
      )
    )
      break;
    if (attempt === 19)
      throw new Error(
        `Indexes for ${definition.id} are still provisioning. Run setup again later.`,
      );
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
console.info(
  'Private folder sync tables provisioned. Sync scheduling remains disabled; no photo provider calls made.',
);
