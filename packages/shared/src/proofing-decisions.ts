export const PROOFING_DECISIONS = ['favorite', 'maybe', 'rejected'] as const;
export type ProofingDecision = (typeof PROOFING_DECISIONS)[number];
export interface ProofingDecisions {
  version: number;
  updatedAt: string | null;
  unavailableCount: number;
  decisions: { photoId: string; filename: string; status: ProofingDecision }[];
}
