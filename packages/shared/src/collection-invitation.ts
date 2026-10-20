export interface CollectionInvitation {
  id: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface InvitedCollection {
  title: string;
  eventTitle: string;
  expiresAt: string;
  photos: { id: string; filename: string; width?: number; height?: number }[];
}

export const COLLECTION_INVITATION_LIMIT = 100;
