import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createBillingRouter } from '../../apps/api/src/billing/router.js';
import type { AuthOptions } from '../../apps/api/src/auth.js';
import type { BillingService } from '../../apps/api/src/billing/service.js';

const workflows = vi.hoisted(() => ({
  change: vi.fn(),
  cancel: vi.fn(),
  approve: vi.fn(),
  status: vi.fn(),
}));
vi.mock('../../apps/api/src/billing/plan-change-workflow.js', () => ({
  executePlanChange: workflows.change,
}));
vi.mock('../../apps/api/src/billing/plan-cancellation-workflow.js', () => ({
  executePlanCancellation: workflows.cancel,
}));
vi.mock('../../apps/api/src/billing/plan-quote-approval.js', () => ({
  approvePlanQuote: workflows.approve,
}));
vi.mock('../../apps/api/src/billing/plan-status.js', () => ({
  readPlanStatus: workflows.status,
}));

function fixture(enabled = false, verified = true) {
  vi.resetAllMocks();
  const quoteId = randomUUID();
  workflows.status.mockResolvedValue({ change: { quoteId, status: 'quoted' } });
  workflows.change.mockResolvedValue({ status: 'scheduled' });
  workflows.cancel.mockResolvedValue({ status: 'cancelled' });
  const billing = {} as BillingService;
  const auth = {
    webOrigin: 'http://localhost:5173',
    secureCookies: false,
    provider: {
      register: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      getUser: async () => ({
        id: 'owner',
        name: 'Synthetic',
        email: 'owner@example.test',
        emailVerified: verified,
      }),
    },
  } as AuthOptions;
  const app = express();
  app.use(
    '/billing',
    createBillingRouter(auth, billing, { planChangesEnabled: enabled }),
  );
  app.use(
    (
      error: { code?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      void _next;
      res.status(400).json({ code: error.code });
    },
  );
  const post = (action: string, body: object) =>
    request(app)
      .post(`/billing/subscriptions/sub/${action}`)
      .set('Origin', auth.webOrigin)
      .set('Cookie', 'picfind_session=synthetic')
      .send(body);
  return { app, billing, quoteId, post };
}
describe('plan action HTTP boundaries, synthetic workflows only', () => {
  it('keeps new changes disabled by default without recording consent', async () => {
    const f = fixture();
    expect(
      (await f.post('confirm', { quoteId: f.quoteId, confirmed: true })).body
        .code,
    ).toBe('PLAN_CHANGE_UNAVAILABLE');
    expect(workflows.approve).not.toHaveBeenCalled();
    expect(workflows.change).not.toHaveBeenCalled();
  });
  it('requires authentication, trusted origin, and verified email', async () => {
    const f = fixture(true, false);
    expect(
      (await f.post('confirm', { quoteId: f.quoteId, confirmed: true })).body
        .code,
    ).toBe('EMAIL_VERIFICATION_REQUIRED');
    expect(
      (
        await request(f.app)
          .post('/billing/subscriptions/sub/confirm')
          .set('Origin', 'http://localhost:5173')
          .send({})
      ).body.code,
    ).toBe('UNAUTHENTICATED');
    expect(
      (await request(f.app).post('/billing/subscriptions/sub/confirm').send({}))
        .body.code,
    ).toBe('ORIGIN_REJECTED');
    expect(workflows.change).not.toHaveBeenCalled();
  });
  it('rejects request-controlled pricing and enablement', async () => {
    const f = fixture(true);
    expect(
      (
        await f.post('confirm', {
          quoteId: f.quoteId,
          confirmed: true,
          price: 1,
          enabled: true,
        })
      ).body.code,
    ).toBe('INVALID_INPUT');
    expect(workflows.change).not.toHaveBeenCalled();
  });
  it('binds approval and execution to the authenticated owner and saved quote', async () => {
    const f = fixture(true);
    await f
      .post('confirm', { quoteId: f.quoteId, confirmed: true })
      .expect(200);
    expect(workflows.approve).toHaveBeenCalledWith(
      f.billing,
      'owner',
      'sub',
      f.quoteId,
    );
    expect(workflows.change).toHaveBeenCalledWith(
      f.billing,
      'owner',
      'sub',
      f.quoteId,
      true,
    );
  });
  it('does not approve a different quote', async () => {
    const f = fixture(true);
    expect(
      (await f.post('confirm', { quoteId: randomUUID(), confirmed: true })).body
        .code,
    ).toBe('PLAN_QUOTE_CHANGED');
    expect(workflows.approve).not.toHaveBeenCalled();
  });
  it.each(['schedule', 'cancel'])(
    'recovery of %s never authorizes submission',
    async (operation) => {
      const f = fixture();
      await f
        .post('recover-change', { quoteId: f.quoteId, operation })
        .expect(200);
      expect(
        operation === 'cancel' ? workflows.cancel : workflows.change,
      ).toHaveBeenCalledWith(f.billing, 'owner', 'sub', f.quoteId, false);
      expect(workflows.approve).not.toHaveBeenCalled();
    },
  );
});
