import { randomBytes, randomUUID } from 'node:crypto';
import { loadProjectEnvironment } from '../apps/api/src/load-environment.js';
import { AppwriteSourceConnectionStore } from '../apps/api/src/adapters/appwrite-source-connections.js';
import {
  SourceConnections,
  sourceConnectionId,
} from '../apps/api/src/source-connections.js';

loadProjectEnvironment(import.meta.url);
const {
  APPWRITE_ENDPOINT: endpoint,
  APPWRITE_PROJECT_ID: projectId,
  APPWRITE_API_KEY: apiKey,
} = process.env;
if (!endpoint || !projectId || !apiKey)
  throw new Error('Appwrite configuration is required.');
const store = new AppwriteSourceConnectionStore({
  endpoint,
  projectId,
  apiKey,
});
const owner = randomUUID(),
  key = randomBytes(32).toString('hex');
let calls = 0;
const refresh = async () => {
  calls++;
  return {
    accessToken: 'synthetic-rotated-access',
    refreshToken: 'synthetic-rotated-refresh',
    accessExpiresAt: Date.now() + 3600000,
  };
};
const first = new SourceConnections(store, key, refresh);
try {
  await first.connect(owner, 'box', {
    refreshToken: 'synthetic-original-refresh',
    accessExpiresAt: 0,
  });
  const raw = await store.get(sourceConnectionId(owner, 'box'));
  if (!raw || JSON.stringify(raw).includes('synthetic-original-refresh'))
    throw new Error('Connection encryption check failed.');
  const restarted = new SourceConnections(store, key, refresh);
  const access = await restarted.access(owner, 'box');
  if (access.accessToken !== 'synthetic-rotated-access' || calls !== 1)
    throw new Error('Durable refresh checkpoint failed.');
  const again = new SourceConnections(store, key, refresh);
  await again.access(owner, 'box');
  if (calls !== 1) throw new Error('An unnecessary refresh was attempted.');
  await again.disconnect(owner, 'box');
  const disconnected = await store.get(sourceConnectionId(owner, 'box'));
  if (
    disconnected?.encryptedGrant ||
    (await again.status(owner, 'box')).connected
  )
    throw new Error('Disconnect did not erase the grant.');
  console.info(
    'PASS: real private Appwrite connection row, transactional refresh, restarted-process reuse and disconnect. OAuth exchange was synthetic; no AWS or payment calls.',
  );
} finally {
  await first.disconnectOwner(owner);
  await first.removeOwner(owner);
}
if (await store.get(sourceConnectionId(owner, 'box')))
  throw new Error('Diagnostic cleanup is incomplete.');
console.info('Cleanup complete: diagnostic connection row removed.');
