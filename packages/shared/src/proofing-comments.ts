export const PROOFING_COMMENT_LIMIT = 100;
export const PROOFING_COMMENT_LENGTH = 1000;
export interface ProofingComment {
  id: string;
  photoId: string;
  author: 'client' | 'photographer';
  text: string | null;
  createdAt: string;
  removedAt: string | null;
  canRemove: boolean;
}
export interface ProofingDiscussion {
  canPost: boolean;
  remaining: number;
  unavailableCount: number;
  photos: { id: string; filename: string }[];
  comments: ProofingComment[];
}
