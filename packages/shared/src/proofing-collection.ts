export interface ProofingCollection {
  id: string;
  title: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  photoIds: string[];
  photos: { id: string; filename: string }[];
  unavailableCount: number;
  submissionPolicy?: import('./proofing-policy.js').ProofingSubmissionPolicy;
}
export const PROOFING_COLLECTION_LIMIT = 50;
export const PROOFING_COLLECTION_PHOTO_LIMIT = 100;
