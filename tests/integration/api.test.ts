import { expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app';

it('reports process liveness with a server-generated request identifier and no cache', async () => {
  const response = await request(createApp())
    .get('/health')
    .set('X-Request-Id', 'untrusted-value')
    .expect(200);
  expect(response.body).toEqual({ service: 'PicFind', status: 'alive' });
  expect(response.headers['x-request-id']).not.toBe('untrusted-value');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['x-powered-by']).toBeUndefined();
});
it('does not expose unimplemented or protected product data', async () => {
  const response = await request(createApp())
    .get('/events/private-event')
    .expect(404);
  expect(response.body.error.code).toBe('NOT_FOUND');
  expect(response.body.error.requestId).toEqual(expect.any(String));
});
