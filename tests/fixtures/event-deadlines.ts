import { randomUUID } from 'node:crypto';
import { questionnaireFixture } from './questionnaires';
import type { LibraryRecord } from '../../apps/api/src/library';
export function deadlineFixture() {
  const f = questionnaireFixture(),
    now = Date.now();
  const events: LibraryRecord[] = [
    {
      title: 'Portrait deadline',
      expiresAt: new Date(now + 3 * 86400000).toISOString(),
    },
    {
      title: 'Conference delivery',
      expiresAt: new Date(now + 30 * 86400000).toISOString(),
    },
    {
      title: 'Expired gallery',
      expiresAt: new Date(now - 86400000).toISOString(),
    },
    {
      title: 'Archived wedding',
      archived: true,
      expiresAt: new Date(now + 86400000).toISOString(),
    },
    { title: 'Undated event' },
  ].map((fields) => ({
    id: randomUUID(),
    ownerId: f.ownerId,
    kind: 'event',
    createdAt: new Date(now).toISOString(),
    visibility: 'link',
    ...fields,
  }));
  for (const row of events) f.records.set(row.id, row);
  const foreign = {
    ...events[0]!,
    id: randomUUID(),
    ownerId: f.strangerId,
    title: 'Another photographer',
  };
  f.records.set(foreign.id, foreign);
  return { ...f, events, foreign, deadlineRoot: '/api/studio/event-deadlines' };
}
