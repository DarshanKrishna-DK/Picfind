import { ApiError } from './auth.js';
const queues = new Map<string, Promise<unknown>>();
const deletedAccounts = new Set<string>();
export const markDeletedAccount = (id: string) => deletedAccounts.add(id);
async function acquire<T>(
  id: string,
  operation: () => Promise<T>,
  allowDeleted = false,
): Promise<T> {
  const previous = queues.get(id) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => {
      if (!allowDeleted && deletedAccounts.has(id))
        throw new ApiError(
          401,
          'UNAUTHENTICATED',
          'This account is no longer available.',
        );
      return operation();
    });
  queues.set(id, next);
  try {
    return await next;
  } finally {
    if (queues.get(id) === next) queues.delete(id);
  }
}
export function withAccountLock<T>(
  id: string,
  operation: () => Promise<T>,
): Promise<T> {
  return acquire(id, operation);
}
export function withAccountLocks<T>(
  ids: readonly string[],
  operation: () => Promise<T>,
  options: { allowDeleted?: readonly string[] } = {},
): Promise<T> {
  const ordered = [...new Set(ids)].sort(),
    allowed = new Set(options.allowDeleted ?? []);
  if (
    !ordered.length ||
    ordered.length > 401 ||
    ordered.some((id) => typeof id !== 'string' || !id || id.length > 128) ||
    [...allowed].some((id) => !ordered.includes(id))
  )
    throw new Error('Choose a bounded, nonempty set of account locks.');
  const next = (offset: number): Promise<T> =>
    offset === ordered.length
      ? operation()
      : acquire(
          ordered[offset]!,
          () => next(offset + 1),
          allowed.has(ordered[offset]!),
        );
  return next(0);
}
