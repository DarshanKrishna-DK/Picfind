export const RETOUCHING_STATUSES = ['queued', 'editing', 'ready'] as const;
export type RetouchingStatus = (typeof RETOUCHING_STATUSES)[number];
export const RETOUCHING_CHANGE_LIMIT = 30;

export interface RetouchingChange {
  version: number;
  status: RetouchingStatus;
  note: string;
  at: string;
}
export interface StoredRetouchingTask {
  collectionId: string;
  invitationId: string;
  submissionId: string;
  photoId: string;
  history: RetouchingChange[];
}
export interface RetouchingItem {
  photoId: string;
  filename: string;
  version: number;
  status: RetouchingStatus;
  note: string;
  history: RetouchingChange[];
}
export interface RetouchingChecklist {
  submissionId: string;
  round: number;
  readOnly: boolean;
  unavailableCount: number;
  items: RetouchingItem[];
}

export function retouchingTransition(
  from: RetouchingStatus,
  to: RetouchingStatus,
  note: string,
) {
  if (from === to) return true;
  if (from === 'queued' && to === 'editing') return true;
  if (from === 'editing' && to === 'ready') return true;
  return (
    ((from === 'editing' && to === 'queued') ||
      (from === 'ready' && to === 'editing')) &&
    note.trim().length > 0
  );
}
