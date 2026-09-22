import { ApiError } from './auth.js';
const queues = new Map<string, Promise<unknown>>();
const deletedAccounts = new Set<string>();
export const markDeletedAccount = (id: string) => deletedAccounts.add(id);
export async function withAccountLock<T>(
  id: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(id) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => {
      if (deletedAccounts.has(id))
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
