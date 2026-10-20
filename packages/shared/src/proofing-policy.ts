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
    return `Save ${policy.minimum - count} more favorites before submitting.`;
  if (count > policy.maximum)
    return `Remove ${count - policy.maximum} favorites before submitting.`;
  return `${count} saved favorites meet the submission count.`;
}
