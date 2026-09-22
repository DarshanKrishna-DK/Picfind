import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app.js';
import type { LibraryStore } from '../../apps/api/src/library.js';
import {
  SourceConnections,
  sourceConnectionId,
  type SourceConnectionRecord,
  type SourceConnectionStore,
} from '../../apps/api/src/source-connections.js';
import { sealDriveValue } from '../../apps/api/src/drive-connection.js';

const origin = 'http://localhost:5173';
function setup() {
  const owner = randomUUID(),
    rows = new Map<string, SourceConnectionRecord>(),
    order: string[] = [];
  const connectionsStore: SourceConnectionStore = {
    get: async (id) => structuredClone(rows.get(id)),
    remove: async (id) => {
      order.push('remove-connection');
      rows.delete(id);
    },
    mutate: async (id, operation) => {
      const result = operation(structuredClone(rows.get(id)));
      if (result.record) {
        rows.set(id, result.record);
        if (result.record.state === 'disconnected') order.push('disconnect');
      }
      return result.result;
    },
  };
  const sourceConnections = new SourceConnections(
    connectionsStore,
    'ab'.repeat(32),
    vi.fn(async () => ({
      accessToken: 'synthetic-refreshed',
      accessExpiresAt: Date.now() + 3600000,
    })),
  );
  const store: LibraryStore = {
    list: async () => {
      order.push('library-cleanup');
      return [];
    },
    get: vi.fn(),
    put: vi.fn(),
    remove: vi.fn(),
    upload: vi.fn(),
    file: vi.fn(),
    removeFile: vi.fn(),
  };
  const app = createApp(
    {
      webOrigin: origin,
      secureCookies: false,
      provider: {
        register: vi.fn(),
        login: async () => ({
          secret: 'reauth',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        }),
        logout: vi.fn(),
        verifyActionCode: vi.fn(async () => {}),
        getUser: async () => ({
          id: owner,
          name: 'Synthetic',
          email: 'synthetic@example.test',
          emailVerified: true,
        }),
        deleteUser: async () => {
          order.push('delete-user');
        },
      },
    },
    {
      store,
      sourceConnections,
      driveOAuth: { clientId: 'id', clientSecret: 'secret' },
    },
  );
  return { app, owner, rows, order, sourceConnections };
}
describe('persistent source account and Drive integration', () => {
  it('disconnects credentials before deleting photos and erases them before removing the account', async () => {
    const f = setup();
    await f.sourceConnections.connect(f.owner, 'box', {
      accessToken: 'private',
      refreshToken: 'private-refresh',
      accessExpiresAt: Date.now() + 3600000,
    });
    await f.sourceConnections.connect('unrelated-owner', 'box', {
      accessToken: 'untouched',
      accessExpiresAt: Date.now() + 3600000,
    });
    await request(f.app)
      .delete('/api/account')
      .set('Cookie', 'picfind_session=synthetic')
      .set('Origin', origin)
      .send({
        password: 'synthetic-password',
        confirmation: 'DELETE',
        emailCode: '123456',
      })
      .expect(204);
    expect(f.order.indexOf('disconnect')).toBeLessThan(
      f.order.indexOf('library-cleanup'),
    );
    expect(f.order.indexOf('remove-connection')).toBeLessThan(
      f.order.indexOf('delete-user'),
    );
    expect(f.rows.has(sourceConnectionId(f.owner, 'box'))).toBe(false);
    expect(
      (await f.sourceConnections.access('unrelated-owner', 'box')).accessToken,
    ).toBe('untouched');
  });
  it('does not delete account data if durable credential revocation fails', async () => {
    const f = setup();
    vi.spyOn(f.sourceConnections, 'disconnectOwner').mockRejectedValueOnce(
      new Error('Synthetic storage outage'),
    );
    await request(f.app)
      .delete('/api/account')
      .set('Cookie', 'picfind_session=synthetic')
      .set('Origin', origin)
      .send({
        password: 'synthetic-password',
        confirmation: 'DELETE',
        emailCode: '123456',
      })
      .expect(500);
    expect(f.order).not.toContain('library-cleanup');
    expect(f.order).not.toContain('delete-user');
  });
  it('reports Drive state from server storage and ignores disconnected legacy cookies', async () => {
    const f = setup();
    await f.sourceConnections.connect(f.owner, 'drive', {
      refreshToken: 'private',
      accessExpiresAt: 0,
    });
    const status = await request(f.app)
      .get('/api/capabilities')
      .set('Cookie', 'picfind_session=synthetic')
      .expect(200);
    expect(status.body.driveConnected).toBe(true);
    await request(f.app)
      .delete('/api/drive')
      .set('Cookie', 'picfind_session=synthetic')
      .set('Origin', origin)
      .expect(204);
    const old = sealDriveValue(
      {
        clientId: 'id',
        clientSecret: 'secret',
        webOrigin: origin,
        secureCookies: false,
      },
      f.owner,
      'old-grant',
      'refresh',
    );
    const disconnected = await request(f.app)
      .get('/api/capabilities')
      .set('Cookie', 'picfind_session=synthetic; picfind_drive=' + old)
      .expect(200);
    expect(disconnected.body.driveConnected).toBe(false);
    expect(
      f.rows.get(sourceConnectionId(f.owner, 'drive'))?.encryptedGrant,
    ).toBeUndefined();
  });
});
