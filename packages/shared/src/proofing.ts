export const SELECTION_STATUSES = ['new', 'in-progress', 'completed'] as const;
export type SelectionStatus = (typeof SELECTION_STATUSES)[number];

export interface SelectionReview {
  reviewStatus: SelectionStatus;
  reviewNote: string;
  reviewVersion: number;
  reviewedAt: string | null;
}

// Owner-only view. Never return this shape from a public gallery endpoint.
export interface EventSelection extends SelectionReview {
  id: string;
  name: string;
  note: string;
  photoIds: string[];
  photos: { id: string; filename: string }[];
  createdAt: string;
}
