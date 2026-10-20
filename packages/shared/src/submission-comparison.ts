import type { ComparedPhoto } from './selection-comparison.js';

export interface ComparedRound {
  invitationId: string;
  submissionId: string;
  round: number;
  submittedAt: string;
  favoriteCount: number;
  unavailableCount: number;
}

export interface SubmissionComparison {
  collectionVersion: number;
  checkedAt: string;
  first: ComparedRound;
  second: ComparedRound;
  shared: number;
  photos: ComparedPhoto[];
}

export interface SubmissionComparisonChoice {
  firstInvitationId: string;
  firstSubmissionId: string;
  secondInvitationId: string;
  secondSubmissionId: string;
}
