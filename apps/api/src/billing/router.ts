import express, { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { ApiError, readSession, type AuthOptions } from '../auth.js';
import type { BillingService } from './service.js';
import { previewPlanChange } from './plan-preview.js';
import { createPlanQuote } from './plan-quotes.js';
import { readPlanStatus } from './plan-status.js';
import { discardPlanQuote } from './plan-discard.js';
import { approvePlanQuote } from './plan-quote-approval.js';
import { executePlanChange } from './plan-change-workflow.js';
import { executePlanCancellation } from './plan-cancellation-workflow.js';
import { PAID_PLAN_IDS, ORGANIZER_PLAN_IDS } from './model.js';

export function createBillingRouter(
  auth: AuthOptions,
  billing?: BillingService,
  options: { planChangesEnabled?: boolean } = {
    planChangesEnabled: billing?.planChangesEnabled ?? false,
  },
) {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  const service = () => {
    if (!billing)
      throw new ApiError(
        503,
        'BILLING_DISABLED',
        'Billing is not configured. No payment can be started.',
      );
    return billing;
  };
  // Raw bytes and provider signature, deliberately before Origin/session/JSON middleware.
  router.post(
    '/webhook',
    express.raw({ type: 'application/json', limit: '256kb' }),
    async (req, res) => {
      const instance = service();
      if (!instance.provider)
        throw new ApiError(
          503,
          'BILLING_DISABLED',
          'Billing webhooks are not configured.',
        );
      if (!Buffer.isBuffer(req.body))
        throw new ApiError(
          400,
          'INVALID_WEBHOOK',
          'An exact JSON webhook body is required.',
        );
      const headers: Record<string, string> = {};
      for (const name of [
        'webhook-id',
        'webhook-signature',
        'webhook-timestamp',
      ])
        headers[name] = req.get(name) ?? '';
      const event = await instance.provider.verify(
        req.body.toString('utf8'),
        headers,
      );
      await instance.apply(event);
      res.json({ received: true });
    },
  );
  router.use((req, _res, next) => {
    if (
      (req.get('Origin') && req.get('Origin') !== auth.webOrigin) ||
      (!['GET', 'HEAD'].includes(req.method) &&
        req.get('Origin') !== auth.webOrigin)
    )
      return next(
        new ApiError(
          403,
          'ORIGIN_REJECTED',
          'A trusted request origin is required.',
        ),
      );
    next();
  });
  router.use(
    rateLimit({
      windowMs: 60000,
      limit: 30,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
  );
  router.use(express.json({ limit: '4kb' }));
  async function user(req: Request) {
    const session = readSession(
      req,
      auth.secureCookies ? '__Host-picfind_session' : 'picfind_session',
    );
    if (!session)
      throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in to continue.');
    if (!auth.provider)
      throw new ApiError(
        503,
        'AUTH_UNAVAILABLE',
        'Account access is not configured.',
      );
    return auth.provider.getUser(session);
  }
  router.get('/', async (req, res) =>
    res.json({
      ...(await service().summary((await user(req)).id)),
      planChangeCancellationAvailable:
        options.planChangesEnabled === true &&
        Boolean(
          billing?.provider?.cancelScheduledPlanChange &&
          billing.provider.inspectScheduledPlanCancellation,
        ),
      planChangesAvailable:
        options.planChangesEnabled === true &&
        Boolean(
          billing?.provider?.schedulePlanChange &&
          billing.provider.inspectPlanChange,
        ),
    }),
  );
  router.post('/checkout', async (req, res) => {
    const account = await user(req);
    const input = z
      .object({
        requestId: z.uuid(),
        plan: z.enum(PAID_PLAN_IDS),
        currency: z.enum(['INR', 'USD']),
        acceptedTerms: z.literal(true),
      })
      .strict()
      .safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_INPUT',
        'Choose a plan and currency and accept the purchase terms.',
      );
    res.json(
      await service().checkout(
        account,
        input.data.requestId,
        input.data.plan,
        input.data.currency,
      ),
    );
  });
  router.post('/checkout/:id/resume', async (req, res) => {
    const account = await user(req);
    if (
      !z
        .string()
        .regex(/^[a-f0-9]{36}$/)
        .safeParse(req.params.id).success ||
      !z
        .object({})
        .strict()
        .safeParse(req.body ?? {}).success
    )
      throw new ApiError(
        400,
        'INVALID_INPUT',
        'Choose a saved checkout from your billing account.',
      );
    res.json(await service().resumeCheckout(account, String(req.params.id)));
  });
  router.post('/reconcile', async (req, res) => {
    if (
      !z
        .object({})
        .strict()
        .safeParse(req.body ?? {}).success
    )
      throw new ApiError(
        400,
        'INVALID_INPUT',
        'Payment status uses only your saved account records.',
      );
    res.json(await service().reconcile((await user(req)).id));
  });
  router.post('/subscriptions/:id/cancel', async (req, res) => {
    const account = await user(req);
    const input = z
      .object({
        mode: z.enum(['period-end', 'immediate']),
        confirmed: z.literal(true),
      })
      .strict()
      .safeParse(req.body);
    if (
      !input.success ||
      !z.string().min(1).max(200).safeParse(req.params.id).success
    )
      throw new ApiError(
        400,
        'INVALID_INPUT',
        'Choose and confirm how you want to cancel this subscription.',
      );
    res.json(
      await service().cancelSubscription(
        account.id,
        String(req.params.id),
        input.data.mode === 'immediate',
      ),
    );
  });
  router.post('/subscriptions/:id/plan-preview', async (req, res) => {
    const account = await user(req);
    const input = z
      .object({ plan: z.enum(['creator', 'studio', ...ORGANIZER_PLAN_IDS]) })
      .strict()
      .safeParse(req.body);
    if (
      !input.success ||
      !z.string().min(1).max(200).safeParse(req.params.id).success
    )
      throw new ApiError(
        400,
        'INVALID_INPUT',
        'Choose a subscription plan to preview.',
      );
    res.json(
      await previewPlanChange(
        service(),
        account.id,
        String(req.params.id),
        input.data.plan,
      ),
    );
  });
  router.post('/portal', async (req, res) =>
    res.json(await service().portal((await user(req)).id)),
  );
  router.post('/subscriptions/:id/plan-quote', async (req, res) => {
    const account = await user(req);
    if (!account.emailVerified)
      throw new ApiError(
        403,
        'EMAIL_VERIFICATION_REQUIRED',
        'Verify your email before preparing a plan change.',
      );
    const parsed = z
      .object({ plan: z.enum(['creator', 'studio', ...ORGANIZER_PLAN_IDS]) })
      .strict()
      .safeParse(req.body);
    const id = z.string().min(1).max(100).safeParse(req.params.id);
    if (!parsed.success || !id.success)
      throw new ApiError(
        400,
        'INVALID_INPUT',
        'Choose a subscription plan. Prices and currency are determined by your saved subscription.',
      );
    res.json(
      await createPlanQuote(service(), account.id, id.data, parsed.data.plan),
    );
  });
  router.get('/subscriptions/:id/plan-status', async (req, res) => {
    const account = await user(req);
    const id = z.string().min(1).max(100).safeParse(req.params.id);
    if (!id.success)
      throw new ApiError(
        400,
        'INVALID_INPUT',
        'Choose a subscription from your billing account.',
      );
    res.json(await readPlanStatus(service(), account.id, id.data));
  });
  for (const action of [
    'confirm',
    'cancel-change',
    'recover-change',
  ] as const) {
    router.post(`/subscriptions/:id/${action}`, async (req, res) => {
      const account = await user(req);
      if (!account.emailVerified)
        throw new ApiError(
          403,
          'EMAIL_VERIFICATION_REQUIRED',
          'Verify your email before managing a plan change.',
        );
      const id = z.string().min(1).max(100).safeParse(req.params.id);
      const input = (
        action === 'recover-change'
          ? z
              .object({
                quoteId: z.uuid(),
                operation: z.enum(['schedule', 'cancel']),
              })
              .strict()
          : z.object({ quoteId: z.uuid(), confirmed: z.literal(true) }).strict()
      ).safeParse(req.body);
      if (!id.success || !input.success)
        throw new ApiError(
          400,
          'INVALID_INPUT',
          'Select and confirm a saved plan change. Prices cannot be supplied in this request.',
        );
      const instance = service();
      if (action === 'recover-change') {
        const operation =
          'operation' in input.data ? input.data.operation : undefined;
        res.json(
          await (
            operation === 'cancel' ? executePlanCancellation : executePlanChange
          )(instance, account.id, id.data, input.data.quoteId, false),
        );
        return;
      }
      if (options.planChangesEnabled !== true)
        throw new ApiError(
          409,
          'PLAN_CHANGE_UNAVAILABLE',
          'Plan-change confirmation is not enabled. No change was submitted.',
        );
      if (action === 'cancel-change') {
        res.json(
          await executePlanCancellation(
            instance,
            account.id,
            id.data,
            input.data.quoteId,
            true,
          ),
        );
        return;
      }
      const saved = await readPlanStatus(instance, account.id, id.data);
      if (!saved.change || saved.change.quoteId !== input.data.quoteId)
        throw new ApiError(
          409,
          'PLAN_QUOTE_CHANGED',
          'Refresh billing before confirming this change.',
        );
      if (
        saved.change.status === 'quoted' ||
        saved.change.status === 'approved'
      )
        await approvePlanQuote(
          instance,
          account.id,
          id.data,
          input.data.quoteId,
        );
      res.json(
        await executePlanChange(
          instance,
          account.id,
          id.data,
          input.data.quoteId,
          true,
        ),
      );
    });
  }
  router.post('/subscriptions/:id/discard-quote', async (req, res) => {
    const account = await user(req);
    const id = z.string().min(1).max(100).safeParse(req.params.id);
    const input = z
      .object({ quoteId: z.uuid(), confirmed: z.literal(true) })
      .strict()
      .safeParse(req.body);
    if (!id.success || !input.success)
      throw new ApiError(
        400,
        'INVALID_INPUT',
        'Confirm the saved quote you want to discard.',
      );
    res.json(
      await discardPlanQuote(
        service(),
        account.id,
        id.data,
        input.data.quoteId,
      ),
    );
  });
  return router;
}
