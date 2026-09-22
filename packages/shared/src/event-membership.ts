export const MAX_EVENT_MODERATORS = 64;
export interface EventMembership {
  userId: string;
  role: 'moderator';
  grantId: string;
  addedAt: string;
}
export interface EventMemberView extends EventMembership {
  name: string;
  email: string;
}
