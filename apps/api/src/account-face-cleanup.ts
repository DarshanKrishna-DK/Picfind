import type {
  FaceMatchingProvider,
  Scope,
} from '../../../packages/shared/src/ports.js';
import { ApiError } from './auth.js';
import { uncertainFaceIndex } from './face-cleanup-state.js';
import type { LibraryStore } from './library.js';

// Account deletion keeps its existing reauthentication and lock. This wrapper
// prevents deletion of the last cleanup reference while provider erasure fails.
export function withAccountFaceCleanup(
  store: LibraryStore | undefined,
  matcher: FaceMatchingProvider | undefined,
): LibraryStore | undefined {
  if (!store) return undefined;
  return new Proxy(store, {
    get(target, property) {
      if (property === 'remove')
        return async (id: string) => {
          const row = await target.get(id);
          const scope: Scope | undefined = row.scanId
            ? { kind: 'scan', id: row.scanId.replaceAll('-', '') }
            : row.eventId
              ? { kind: 'event', id: row.eventId }
              : undefined;
          const scan = row.kind === 'job' && row.purpose === 'discover-scan';
          const uncertain = uncertainFaceIndex(row);
          if (
            (row.provider ||
              row.faceIds?.length ||
              uncertain ||
              (scan && row.provider)) &&
            !matcher
          )
            throw new ApiError(
              503,
              'FACE_DELETION_INCOMPLETE',
              'Photo matching must reconnect before this account can finish deleting its face indexes. Retry deletion later.',
            );
          try {
            if (uncertain && !scope)
              throw new Error('The cleanup scope must be repaired.');
            if (matcher && uncertain && scope) await matcher.deleteScope(scope);
            else if (
              matcher &&
              row.kind === 'photo' &&
              scope &&
              row.faceIds?.length
            )
              await matcher.deleteFaces(scope, row.faceIds);
            if (matcher && row.kind === 'event')
              await matcher.deleteScope({ kind: 'event', id: row.id });
            if (matcher && scan)
              await matcher.deleteScope({
                kind: 'scan',
                id: row.id.replaceAll('-', ''),
              });
          } catch (error) {
            if (
              !(error instanceof ApiError && error.status === 404) &&
              !(
                error instanceof Error &&
                error.name === 'ResourceNotFoundException'
              )
            )
              throw new ApiError(
                503,
                'FACE_DELETION_INCOMPLETE',
                'The provider could not finish erasing this account. Cleanup records were retained; retry deletion later.',
              );
          }
          if (row.kind === 'job' && row.purpose === 'upload-cleanup')
            await target.removeFile(row.id);
          await target.remove(id);
        };
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
