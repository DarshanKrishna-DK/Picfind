import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { AppwriteLibraryStore } from '../apps/api/src/adapters/appwrite-library.js';
import { ApiError } from '../apps/api/src/auth.js';
import type { LibraryRecord } from '../apps/api/src/library.js';

// Explicitly opted-in, metadata-only persistence check. No users, images or AWS calls.
async function main() {
  if (process.env.PICFIND_ORGANIZER_STORAGE_TEST !== '1')
    throw new Error(
      'Set PICFIND_ORGANIZER_STORAGE_TEST=1 to create and clean up two disposable private records.',
    );
  function required(name: string) {
    const value = process.env[name];
    if (!value) throw new Error(`Missing ${name}.`);
    return value;
  }
  const config = {
    endpoint: required('APPWRITE_ENDPOINT'),
    projectId: required('APPWRITE_PROJECT_ID'),
    apiKey: required('APPWRITE_API_KEY'),
  };
  const store = new AppwriteLibraryStore(config);
  const ownerId = randomUUID();
  const event: LibraryRecord = {
    id: randomUUID(),
    ownerId,
    kind: 'event',
    title: 'Disposable organizer diagnostic',
    folder: 'Synthetic private folder',
    visibility: 'private',
    createdAt: new Date().toISOString(),
  };
  const selection: LibraryRecord = {
    id: randomUUID(),
    ownerId,
    kind: 'job',
    purpose: 'selection',
    eventId: event.id,
    visitorName: 'Synthetic guest',
    note: 'Synthetic request',
    selectedIds: [],
    createdAt: event.createdAt,
  };
  const touched: string[] = [];
  try {
    for (const row of [event, selection]) {
      touched.push(row.id); // Also clean up an ambiguously acknowledged creation.
      await store.put(row, true);
    }
    const reloaded = new AppwriteLibraryStore(config);
    assert.equal((await reloaded.get(event.id)).folder, event.folder);
    await reloaded.put({
      ...(await reloaded.get(selection.id)),
      reviewStatus: 'completed',
      reviewNote: 'Synthetic private review',
      reviewVersion: 1,
      reviewedAt: new Date().toISOString(),
    });
    const final = await new AppwriteLibraryStore(config).get(selection.id);
    assert.equal(final.reviewStatus, 'completed');
    assert.equal(final.reviewNote, 'Synthetic private review');
    assert.equal(final.reviewVersion, 1);
    assert.equal(final.note, selection.note);
  } finally {
    const remaining: string[] = [];
    for (const id of touched.reverse()) {
      try {
        await store.remove(id);
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404))
          remaining.push(id);
      }
    }
    if (remaining.length) {
      console.error(JSON.stringify({ cleanupRequired: remaining }));
      process.exitCode = 1;
    }
  }
  if (!process.exitCode)
    console.log(
      JSON.stringify({
        check: 'organizer-private-metadata',
        persistedAcrossInstances: true,
        guestInputPreserved: true,
        disposableRecordsRemoved: 2,
        photoUploads: 0,
        awsCalls: 0,
      }),
    );
}

main().catch(() => {
  console.error(
    'Organizer metadata persistence check failed. No credentials are logged. Inspect Appwrite connectivity and the diagnostic cleanup output.',
  );
  process.exitCode = 1;
});
