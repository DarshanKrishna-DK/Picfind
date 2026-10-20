export interface StoredProofingSubmission {
  id: string;
  round: number;
  submittedAt: string;
  decisionVersion: number;
  collectionVersion: number;
  favoriteIds: string[];
  note: string;
}

export interface ProofingSubmission extends Omit<
  StoredProofingSubmission,
  'favoriteIds'
> {
  favoriteCount: number;
  unavailableCount: number;
  photos: { photoId: string; filename: string }[];
}

export interface ProofingSubmissionState {
  round: number;
  decisionVersion: number;
  collectionVersion: number;
  current: ProofingSubmission | null;
  history: ProofingSubmission[];
  reopenReason: string | null;
  canReopen: boolean;
  requirements?: import('./proofing-policy.js').ProofingSubmissionRequirements;
}
