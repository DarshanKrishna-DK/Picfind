import { createHash } from 'node:crypto';

/** Internal storage key. Public submission UUIDs remain scoped to an invitation. */
export function submissionArchiveId(
  invitationId: string,
  submissionId: string,
) {
  return createHash('sha256')
    .update('picfind:proofing-archive:v1\0')
    .update(invitationId)
    .update('\0')
    .update(submissionId)
    .digest('hex')
    .slice(0, 32);
}
