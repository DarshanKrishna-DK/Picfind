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

// Guest-only projection. Do not add private organizer review fields here.
export interface SelectionReceipt {
  id: string;
  name: string;
  note: string;
  createdAt: string;
  originalCount: number;
  unavailableCount: number;
  photos: { id: string; filename: string }[];
}

export interface SelectionReceiptPage {
  receipts: SelectionReceipt[];
  nextCursor: string | null;
}
