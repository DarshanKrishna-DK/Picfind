export interface OrganizerEntitlement {
  plan: string;
  retentionDays: number;
  liveEvents: number;
  paidThrough: string;
}
export interface OrganizerEventPolicy {
  entitlement: OrganizerEntitlement | null;
  activeEvents: number | null;
  remainingEvents: number;
  maximumExpiresAt: string | null;
  serverNow: string;
  canCreate: boolean;
  catalogAvailable: boolean;
}
