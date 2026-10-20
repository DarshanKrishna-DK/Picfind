import type { SelectionWindow } from './selection-window.js';

export interface ProofingSubmissionPolicy {
  minimum: number;
  maximum: number;
  closesAt: string | null;
}

export const DEFAULT_PROOFING_POLICY: Readonly<ProofingSubmissionPolicy> = {
  minimum: 0,
  maximum: 100,
  closesAt: null,
};

export interface ProofingSubmissionRequirements {
  policy: ProofingSubmissionPolicy;
  window: SelectionWindow;
  favoriteCount: number;
  unavailableCount: number;
}

export function proofingCountHint(
  count: number,
  policy: ProofingSubmissionPolicy,
) {
  if (count < policy.minimum)
    return `Mark ${policy.minimum - count} more ${policy.minimum - count === 1 ? 'photo' : 'photos'} as Favorite using the photo decision controls above.`;
  if (count > policy.maximum)
    return `Change ${count - policy.maximum} ${count - policy.maximum === 1 ? 'favorite' : 'favorites'} using the photo decision controls above before submitting.`;
  return `${count} saved favorites meet the submission count.`;
}
