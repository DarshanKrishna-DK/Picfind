import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { ApiError } from './auth.js';

export const SOURCE_PROVIDERS = [
  'drive',
  'dropbox',
  'onedrive',
  'box',
] as const;
export type SourceProvider = (typeof SOURCE_PROVIDERS)[number];
export interface SourceGrant {
  accessToken?: string;
  refreshToken?: string;
  accessExpiresAt: number;
}
export interface SourceConnectionRecord {
  id: string;
  ownerId: string;
  provider: SourceProvider;
  generation: string;
  state: 'connected' | 'refreshing' | 'reconnect' | 'disconnected';
  encryptedGrant?: string;
  refreshAttempt?: string;
  refreshStartedAt?: number;
  lastRefreshAttempt?: string;
  authorizationAttempt?: string;
  updatedAt: string;
}
export interface SourceConnectionStore {
  get(id: string): Promise<SourceConnectionRecord | undefined>;
  mutate<T>(
    id: string,
    operation: (record: SourceConnectionRecord | undefined) => {
      record?: SourceConnectionRecord;
      result: T;
    },
  ): Promise<T>;
  remove(id: string): Promise<void>;
}
export type SourceRefresh = (
  provider: SourceProvider,
  refreshToken: string,
) => Promise<SourceGrant>;
export const sourceConnectionId = (ownerId: string, provider: SourceProvider) =>
  createHash('sha256')
    .update('source-connection:' + ownerId + ':' + provider)
    .digest('hex')
    .slice(0, 36);
const reconnect = () =>
  new ApiError(
    401,
    'SOURCE_RECONNECT_REQUIRED',
    'Reconnect this cloud source for your PicFind account before continuing.',
  );
const changed = () =>
  new ApiError(
    409,
    'SOURCE_CONNECTION_CHANGED',
    'This cloud connection changed. Reopen the source and confirm your selection again.',
  );
const pending = () =>
  new ApiError(
    503,
    'SOURCE_REFRESH_PENDING',
    'The cloud connection is refreshing. Retry shortly; no second refresh was started.',
  );
const MAX_REFRESH_TIME = 60_000;
type Access = { accessToken: string; expiresAt: number; generation: string };
function validGrant(value: SourceGrant): boolean {
  return (
    !!value &&
    Number.isFinite(value.accessExpiresAt) &&
    value.accessExpiresAt >= 0 &&
    [value.accessToken, value.refreshToken].every(
      (token) =>
        token === undefined ||
        (typeof token === 'string' &&
          token.length > 0 &&
          token.length <= 16384),
    ) &&
    Boolean(value.accessToken || value.refreshToken) &&
    Buffer.byteLength(JSON.stringify(value)) <= 32000
  );
}
export class SourceConnections {
  private readonly key: Buffer;
  private readonly pending = new Map<string, Promise<Access>>();
  constructor(
    private readonly store: SourceConnectionStore,
    key: string,
    private readonly refresh: SourceRefresh,
    private readonly now: () => number = Date.now,
  ) {
    if (!/^[a-f\d]{64}$/i.test(key))
      throw new Error(
        'SOURCE_COOKIE_KEY must contain 32 random bytes encoded as 64 hexadecimal characters.',
      );
    this.key = Buffer.from(key, 'hex');
  }
  private identity(ownerId: string, provider: SourceProvider) {
    if (!ownerId || ownerId.length > 64 || !SOURCE_PROVIDERS.includes(provider))
      throw reconnect();
    return sourceConnectionId(ownerId, provider);
  }
  private own(
    row: SourceConnectionRecord | undefined,
    ownerId: string,
    provider: SourceProvider,
  ) {
    if (
      row &&
      (row.id !== this.identity(ownerId, provider) ||
        row.ownerId !== ownerId ||
        row.provider !== provider)
    )
      throw new ApiError(
        503,
        'SOURCE_STORAGE_INVALID',
        'Cloud connection metadata needs repair.',
      );
    return row;
  }
  private seal(
    row: Pick<SourceConnectionRecord, 'ownerId' | 'provider' | 'generation'>,
    grant: SourceGrant,
  ) {
    if (!validGrant(grant)) throw reconnect();
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(
      Buffer.from(
        JSON.stringify([
          'picfind-source-v1',
          row.ownerId,
          row.provider,
          row.generation,
        ]),
      ),
    );
    const clear = Buffer.from(JSON.stringify(grant));
    try {
      const ciphertext = Buffer.concat([cipher.update(clear), cipher.final()]);
      return [
        'v1',
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        ciphertext.toString('base64url'),
      ].join('.');
    } finally {
      clear.fill(0);
    }
  }
  private open(row: SourceConnectionRecord): SourceGrant {
    try {
      if (!row.encryptedGrant || row.encryptedGrant.length > 48000)
        throw reconnect();
      const parts = row.encryptedGrant.split('.');
      if (parts.length !== 4 || parts[0] !== 'v1') throw reconnect();
      const iv = Buffer.from(parts[1]!, 'base64url'),
        tag = Buffer.from(parts[2]!, 'base64url');
      if (iv.length !== 12 || tag.length !== 16) throw reconnect();
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(
        Buffer.from(
          JSON.stringify([
            'picfind-source-v1',
            row.ownerId,
            row.provider,
            row.generation,
          ]),
        ),
      );
      decipher.setAuthTag(tag);
      const clear = Buffer.concat([
        decipher.update(Buffer.from(parts[3]!, 'base64url')),
        decipher.final(),
      ]);
      try {
        const grant = JSON.parse(clear.toString()) as SourceGrant;
        if (!validGrant(grant)) throw reconnect();
        return grant;
      } finally {
        clear.fill(0);
      }
    } catch {
      throw reconnect();
    }
  }
  async beginAuthorization(ownerId: string, provider: SourceProvider) {
    const id = this.identity(ownerId, provider),
      authorizationAttempt = randomUUID();
    await this.store.mutate(id, (existing) => {
      this.own(existing, ownerId, provider);
      const record: SourceConnectionRecord = {
        ...(existing ?? {
          id,
          ownerId,
          provider,
          generation: randomUUID(),
          state: 'disconnected' as const,
        }),
        authorizationAttempt,
        updatedAt: new Date(this.now()).toISOString(),
      };
      return { record, result: undefined };
    });
    return authorizationAttempt;
  }
  async connect(
    ownerId: string,
    provider: SourceProvider,
    grant: SourceGrant,
    authorizationAttempt?: string,
  ) {
    const id = this.identity(ownerId, provider);
    const row: SourceConnectionRecord = {
      id,
      ownerId,
      provider,
      generation: randomUUID(),
      state: 'connected',
      updatedAt: new Date(this.now()).toISOString(),
    };
    row.encryptedGrant = this.seal(row, grant);
    await this.store.mutate(id, (existing) => {
      this.own(existing, ownerId, provider);
      if (
        authorizationAttempt !== undefined &&
        existing?.authorizationAttempt !== authorizationAttempt
      )
        throw changed();
      return { record: row, result: undefined };
    });
    return { id, generation: row.generation };
  }
  async status(ownerId: string, provider: SourceProvider) {
    const row = this.own(
      await this.store.get(this.identity(ownerId, provider)),
      ownerId,
      provider,
    );
    let usable = false,
      backgroundAccess = false;
    try {
      if (row?.state === 'connected') {
        const grant = this.open(row);
        backgroundAccess = Boolean(grant.refreshToken);
        usable = Boolean(
          grant.refreshToken ||
          (grant.accessToken && grant.accessExpiresAt > this.now()),
        );
      }
    } catch {
      /* Invalid or old encryption keys require renewed authorization, never cookie fallback. */
    }
    const refreshing =
      row?.state === 'refreshing' &&
      (row.refreshStartedAt ?? 0) + MAX_REFRESH_TIME > this.now();
    return {
      persistent: true,
      connected: usable || refreshing,
      backgroundAccess,
      refreshing,
      reconnectRequired: Boolean(
        row && row.state !== 'disconnected' && !usable && !refreshing,
      ),
    };
  }
  async access(
    ownerId: string,
    provider: SourceProvider,
    expectedGeneration?: string,
  ): Promise<Access> {
    const id = this.identity(ownerId, provider);
    let operation = this.pending.get(id);
    if (!operation) {
      operation = this.acquire(ownerId, provider, expectedGeneration);
      this.pending.set(id, operation);
      void operation
        .finally(() => {
          if (this.pending.get(id) === operation) this.pending.delete(id);
        })
        .catch(() => {});
    }
    const access = await operation;
    if (expectedGeneration && access.generation !== expectedGeneration)
      throw changed();
    return access;
  }
  private async acquire(
    ownerId: string,
    provider: SourceProvider,
    expectedGeneration?: string,
  ): Promise<Access> {
    const id = this.identity(ownerId, provider);
    const row = this.own(await this.store.get(id), ownerId, provider);
    if (!row || ['disconnected', 'reconnect'].includes(row.state))
      throw reconnect();
    if (expectedGeneration && row.generation !== expectedGeneration)
      throw changed();
    if (row.state === 'refreshing') {
      if ((row.refreshStartedAt ?? 0) + MAX_REFRESH_TIME <= this.now()) {
        await this.invalidate(id, row.generation, row.refreshAttempt);
        throw reconnect();
      }
      throw pending();
    }
    const grant = this.open(row);
    if (grant.accessToken && grant.accessExpiresAt > this.now() + 30_000)
      return {
        accessToken: grant.accessToken,
        expiresAt: grant.accessExpiresAt,
        generation: row.generation,
      };
    if (!grant.refreshToken) throw reconnect();
    const attempt = randomUUID(),
      started = this.now();
    await this.store.mutate(id, (current) => {
      this.own(current, ownerId, provider);
      if (
        !current ||
        current.generation !== row.generation ||
        current.state === 'disconnected'
      )
        throw changed();
      if (
        current.state !== 'connected' ||
        current.encryptedGrant !== row.encryptedGrant
      )
        throw pending();
      return {
        record: {
          ...current,
          state: 'refreshing',
          refreshAttempt: attempt,
          refreshStartedAt: started,
          updatedAt: new Date(started).toISOString(),
        },
        result: undefined,
      };
    });
    let providerReturned = false;
    try {
      const updated = await this.refresh(provider, grant.refreshToken);
      providerReturned = true;
      if (
        !updated.accessToken ||
        updated.accessExpiresAt <= this.now() + 30_000 ||
        (provider === 'box' && !updated.refreshToken)
      )
        throw reconnect();
      const nextGrant: SourceGrant = {
        ...updated,
        ...(updated.refreshToken ? {} : { refreshToken: grant.refreshToken }),
      };
      const encryptedGrant = this.seal(row, nextGrant);
      await this.store.mutate(id, (current) => {
        this.own(current, ownerId, provider);
        if (
          !current ||
          current.generation !== row.generation ||
          current.state !== 'refreshing' ||
          current.refreshAttempt !== attempt
        )
          throw changed();
        const record: SourceConnectionRecord = {
          ...current,
          state: 'connected',
          encryptedGrant,
          lastRefreshAttempt: attempt,
          updatedAt: new Date(this.now()).toISOString(),
        };
        delete record.refreshAttempt;
        delete record.refreshStartedAt;
        return { record, result: undefined };
      });
      return {
        accessToken: updated.accessToken,
        expiresAt: updated.accessExpiresAt,
        generation: row.generation,
      };
    } catch (error) {
      // Reconcile only a committed response. Never repeat a possibly consumed refresh token.
      if (providerReturned) {
        try {
          const current = this.own(await this.store.get(id), ownerId, provider);
          if (
            current?.generation === row.generation &&
            current.state === 'connected' &&
            current.lastRefreshAttempt === attempt
          ) {
            const saved = this.open(current);
            if (saved.accessToken && saved.accessExpiresAt > this.now())
              return {
                accessToken: saved.accessToken,
                expiresAt: saved.accessExpiresAt,
                generation: current.generation,
              };
          }
        } catch {
          /* Retain the pending claim if storage is unavailable. */
        }
      }
      await this.invalidate(id, row.generation, attempt).catch(() => {});
      if (
        error instanceof ApiError &&
        error.code === 'SOURCE_CONNECTION_CHANGED'
      )
        throw error;
      throw reconnect();
    }
  }
  private async invalidate(id: string, generation: string, attempt?: string) {
    await this.store.mutate(id, (row) => {
      if (
        !row ||
        row.generation !== generation ||
        row.state !== 'refreshing' ||
        row.refreshAttempt !== attempt
      )
        return { result: undefined };
      const record: SourceConnectionRecord = {
        id: row.id,
        ownerId: row.ownerId,
        provider: row.provider,
        generation: row.generation,
        state: 'reconnect',
        updatedAt: new Date(this.now()).toISOString(),
      };
      return { record, result: undefined };
    });
  }
  async disconnect(ownerId: string, provider: SourceProvider) {
    const id = this.identity(ownerId, provider),
      generation = randomUUID();
    await this.store.mutate(id, (row) => {
      this.own(row, ownerId, provider);
      if (!row) return { result: undefined };
      return {
        record: {
          id,
          ownerId,
          provider,
          generation,
          state: 'disconnected',
          updatedAt: new Date(this.now()).toISOString(),
        },
        result: undefined,
      };
    });
  }
  async disconnectOwner(ownerId: string) {
    for (const provider of SOURCE_PROVIDERS)
      await this.disconnect(ownerId, provider);
  }
  async removeOwner(ownerId: string) {
    for (const provider of SOURCE_PROVIDERS) {
      const id = this.identity(ownerId, provider);
      const row = this.own(await this.store.get(id), ownerId, provider);
      if (row) await this.store.remove(id);
    }
  }
}
