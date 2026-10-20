export interface MatchingReadiness {
  checkedAt: string;
  status:
    | 'empty'
    | 'unavailable'
    | 'processing'
    | 'not-prepared'
    | 'partial'
    | 'ready'
    | 'no-faces'
    | 'needs-attention'
    | 'archived'
    | 'expired'
    | 'deleting';
  gallery: 'private' | 'shared' | 'archived' | 'expired' | 'deleting';
  searchAvailable: boolean;
  processingAvailable: boolean;
  provider: 'aws-rekognition' | null;
  counts: {
    total: number;
    prepared: number;
    noFaces: number;
    waiting: number;
    failed: number;
    needsReview: number;
  };
  uncertain: number;
  models: { version: string; photos: number }[];
}
