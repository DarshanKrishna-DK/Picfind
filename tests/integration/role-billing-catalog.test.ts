import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { PHOTO_PLANS } from '../../packages/shared/src/plans.js';
import { planById } from '../../apps/api/src/billing/model.js';
import { createApp } from '../../apps/api/src/app.js';

describe('the published role catalog is understood by the billing boundary', () => {
  for (const plan of PHOTO_PLANS.filter((entry) => entry.id !== 'preview')) {
    it('resolves the immutable billing contract for ' + plan.id, () => {
      expect(planById(plan.id as Parameters<typeof planById>[0])).toEqual(plan);
    });
    it(
      'reports unavailable checkout rather than invalid input for ' + plan.id,
      async () => {
        const app = createApp({
          webOrigin: 'http://localhost:5173',
          secureCookies: false,
          provider: {
            register: vi.fn(),
            login: vi.fn(),
            logout: vi.fn(),
            getUser: async () => ({
              id: randomUUID(),
              name: 'Synthetic',
              email: 'synthetic@example.test',
              emailVerified: true,
            }),
          },
        });
        const response = await request(app)
          .post('/api/billing/checkout')
          .set('Origin', 'http://localhost:5173')
          .set('Cookie', 'picfind_session=synthetic')
          .send({
            requestId: randomUUID(),
            plan: plan.id,
            currency: 'INR',
            acceptedTerms: true,
          });
        expect(response.status).toBe(503);
        expect(response.body.error.code).toBe('BILLING_DISABLED');
      },
    );
  }
});
