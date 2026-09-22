import type { SourceProvider } from './source-connections.js';

export interface ImportSource {
  provider: SourceProvider;
  generation: string;
  destinationEventId?: string;
  actorId?: string;
  membershipGrantId?: string;
  folderSyncId?: string;
}
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function validImportSource(value: unknown): value is ImportSource {
  if (!value || typeof value !== 'object') return false;
  const source = value as ImportSource;
  return (
    ['drive', 'dropbox', 'onedrive', 'box'].includes(source.provider) &&
    typeof source.generation === 'string' &&
    uuid.test(source.generation) &&
    (source.folderSyncId === undefined ||
      (typeof source.folderSyncId === 'string' &&
        uuid.test(source.folderSyncId) &&
        !!source.destinationEventId)) &&
    (source.destinationEventId === undefined ||
      (typeof source.destinationEventId === 'string' &&
        uuid.test(source.destinationEventId))) &&
    ((source.actorId === undefined && source.membershipGrantId === undefined) ||
      (typeof source.actorId === 'string' &&
        /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/.test(source.actorId) &&
        typeof source.membershipGrantId === 'string' &&
        uuid.test(source.membershipGrantId) &&
        !!source.destinationEventId)) &&
    Object.keys(source).every((key) =>
      [
        'provider',
        'generation',
        'destinationEventId',
        'actorId',
        'membershipGrantId',
        'folderSyncId',
      ].includes(key),
    )
  );
}
// Bound the JSON bytes, not just JS string length: Unicode and escaping must
// also fit the private 64 KB manifest column.
export function validImportFileId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    Array.from(value).every(
      (character) =>
        character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127,
    ) &&
    Buffer.byteLength(JSON.stringify(value)) <= 514
  );
}
