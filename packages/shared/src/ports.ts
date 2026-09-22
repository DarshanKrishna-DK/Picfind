export type Currency = 'INR' | 'USD';
export type Scope = { kind: 'event' | 'scan'; id: string };
/** Internal service port. Authorization must resolve persisted scope/consent records. */
export interface FaceMatchingProvider {
  healthCheck(): Promise<void>;
  ensureScope(scope: Scope): Promise<{ modelVersion: string }>;
  indexPhoto(input: {
    scope: Scope;
    photoId: string;
    bytes: Uint8Array;
    consentRecordId: string;
  }): Promise<{
    modelVersion: string;
    externalImageId: string;
    faceIds: string[];
    unindexedReasons: string[][];
  }>;
  search(input: {
    scope: Scope;
    bytes: Uint8Array;
    consentRecordId: string;
  }): Promise<{
    modelVersion: string;
    matches: { faceId: string; externalImageId: string; similarity: number }[];
    limitReached: boolean;
  }>;
  deleteFaces(scope: Scope, faceIds: string[]): Promise<void>;
  deleteScope(scope: Scope): Promise<void>;
}
export interface StorageProvider {
  upload(input: {
    scope: Scope;
    key: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<{ fileId: string }>;
  getSignedUrl(input: {
    fileId: string;
    expiresAt: Date;
  }): Promise<{ url: string; expiresAt: Date }>;
  delete(fileId: string): Promise<void>;
  getMetadata(fileId: string): Promise<{ size: number; contentType: string }>;
}
export interface SourceProvider {
  validate(input: {
    source: string;
    actorId: string;
  }): Promise<{ sourceId: string; title: string; photoCount: number | null }>;
  list(input: {
    sourceId: string;
    actorId: string;
    cursor?: string;
  }): Promise<{ items: { id: string; name: string }[]; cursor: string | null }>;
  read(input: {
    sourceId: string;
    itemId: string;
    actorId: string;
  }): Promise<ReadableStream<Uint8Array>>;
}
export interface BillingProvider {
  createCheckout(input: {
    userId: string;
    productId: string;
    currency: Currency;
    amountMinor: number;
    returnUrl: string;
    idempotencyKey: string;
  }): Promise<{ id: string; url: string }>;
  getCustomer(id: string): Promise<{ id: string }>;
  getSubscription(
    id: string,
  ): Promise<{ id: string; status: string; periodEnd: Date | null }>;
  cancelSubscription(id: string): Promise<void>;
  refundPayment(input: {
    paymentId: string;
    amountMinor: number;
    idempotencyKey: string;
  }): Promise<{ id: string }>;
  syncWebhookEvent(input: {
    rawBody: Uint8Array;
    headers: Record<string, string>;
  }): Promise<{ eventId: string; kind: string; resourceId: string }>;
}
export interface EmailProvider {
  send(input: {
    recipient: string;
    template: string;
    variables: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{ messageId: string }>;
}
