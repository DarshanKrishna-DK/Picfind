import { randomBytes, timingSafeEqual } from 'node:crypto';
import express, { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { clearAccountCookies } from './connection-cookies.js';
import {
  ApiError,
  readSession,
  type AuthOptions,
  type AuthenticationProvider,
} from './auth.js';
import { authenticate, sessionCookieName, trustedOrigin } from './security.js';
import { markDeletedAccount, withAccountLock } from './locks.js';
import type { LibraryStore } from './library.js';
import { studioReturnPath } from '../../../packages/shared/src/navigation.js';

const password = z.string().min(8).max(256);
const emailCode = z.string().regex(/^\d{6}$/);
const token = z
  .object({
    userId: z.string().min(1).max(36),
    secret: z.string().min(1).max(4096),
  })
  .strict();
function input<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success)
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'Check the supplied account details.',
    );
  return result.data;
}
export function createAccountRouter(
  auth: AuthOptions,
  store?: LibraryStore,
  lifecycle: {
    beforeCleanup?(ownerId: string): Promise<void>;
    afterCleanup?(ownerId: string): Promise<void>;
  } = {},
) {
  const router = Router();
  const cookie = {
    httpOnly: true,
    secure: auth.secureCookies,
    sameSite: 'lax' as const,
    path: '/',
  };
  const stateCookie = auth.secureCookies
    ? '__Host-picfind_oauth'
    : 'picfind_oauth';
  const returnCookie = auth.secureCookies
    ? '__Host-picfind_return'
    : 'picfind_return';
  const provider = () => {
    if (!auth.provider)
      throw new ApiError(
        503,
        'AUTH_UNAVAILABLE',
        'Account access is not configured.',
      );
    return auth.provider;
  };
  function method<K extends keyof AuthenticationProvider>(
    key: K,
  ): NonNullable<AuthenticationProvider[K]> {
    const value = provider()[key];
    if (!value)
      throw new ApiError(
        503,
        'FEATURE_UNAVAILABLE',
        'This account feature is not configured.',
      );
    return value.bind(provider()) as NonNullable<AuthenticationProvider[K]>;
  }
  function accountLimit(limit: number): RequestHandler {
    const limiter = rateLimit({
      windowMs: 15 * 60_000,
      limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      keyGenerator: (_req, res) =>
        res.locals.accountConfirmationOwner as string,
      handler: (_req, _res, next) =>
        next(
          new ApiError(
            429,
            'RATE_LIMITED',
            'Too many account confirmation attempts. Please wait 15 minutes before trying again.',
          ),
        ),
    });
    return async (req, res, next) => {
      const { user } = await authenticate(req, auth);
      // Server-resolved identity, never a user id supplied in the request body.
      res.locals.accountConfirmationOwner = user.id;
      limiter(req, res, next);
    };
  }
  const confirmationRequests = accountLimit(5);
  // Share one budget across password and deletion to prevent endpoint hopping.
  const confirmationAttempts = accountLimit(10);
  router.use(trustedOrigin(auth), express.json({ limit: '8kb' }));
  router.use(
    rateLimit({
      windowMs: 15 * 60_000,
      limit: 30,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
  );
  router.get('/capabilities', (_req, res) =>
    res.json({
      google: Boolean(auth.googleEnabled && auth.provider?.beginGoogle),
      recovery: Boolean(auth.provider?.recover),
      verification: Boolean(auth.provider?.sendVerification),
      deletion: Boolean(
        auth.provider?.deleteUser &&
        auth.provider?.sendActionCode &&
        auth.provider?.verifyActionCode &&
        store,
      ),
    }),
  );
  router.post('/recovery', async (req, res) => {
    const { email } = input(
      z.object({ email: z.email().max(320) }).strict(),
      req.body,
    );
    await method('recover')(email, `${auth.webOrigin}/reset-password`);
    res.status(202).json({
      message:
        'If that address has an account, a password reset email has been sent.',
    });
  });
  router.post('/reset-password', async (req, res) => {
    await method('resetPassword')(input(token.extend({ password }), req.body));
    clearAccountCookies(req, res, auth.secureCookies);
    res.clearCookie(sessionCookieName(auth), cookie);
    res.status(204).end();
  });
  router.post('/verification', async (req, res) => {
    const { secret } = await authenticate(req, auth);
    await method('sendVerification')(secret, `${auth.webOrigin}/verify-email`);
    res
      .status(202)
      .json({ message: 'Check your email for the verification link.' });
  });
  router.post('/verify-email', async (req, res) => {
    await method('verifyEmail')(input(token, req.body));
    res.status(204).end();
  });
  router.patch('/profile', async (req, res) => {
    const { secret } = await authenticate(req, auth);
    const { name } = input(
      z.object({ name: z.string().trim().min(1).max(128) }).strict(),
      req.body,
    );
    res.json({ user: await method('updateName')(secret, name) });
  });
  router.post('/password', confirmationAttempts, async (req, res) => {
    const { secret, user } = await authenticate(req, auth);
    const data = input(
      z.object({ oldPassword: password, password, emailCode }).strict(),
      req.body,
    );
    // Resolve every required capability before consuming proof or changing credentials.
    const verifyCode = method('verifyActionCode');
    const changePassword = method('changePassword');
    const revokeOtherSessions = method('revokeOtherSessions');
    await verifyCode(user, data.emailCode);
    await changePassword(secret, data.oldPassword, data.password);
    await revokeOtherSessions(secret);
    res.status(204).end();
  });
  router.post('/confirmation', confirmationRequests, async (req, res) => {
    const { user } = await authenticate(req, auth);
    await method('sendActionCode')(user);
    res
      .status(202)
      .json({ message: 'Check your account email for a one-time code.' });
  });
  router.delete('/sessions/others', async (req, res) => {
    const { secret } = await authenticate(req, auth);
    await method('revokeOtherSessions')(secret);
    res.status(204).end();
  });
  router.post('/google', async (req, res) => {
    if (!auth.googleEnabled)
      throw new ApiError(
        503,
        'GOOGLE_UNAVAILABLE',
        'Google sign-in has not been configured.',
      );
    const state = randomBytes(32).toString('base64url');
    const url = await method('beginGoogle')(
      `${auth.webOrigin}/api/account/google/callback?state=${state}`,
      `${auth.webOrigin}/sign-in?error=google`,
    );
    res.cookie(stateCookie, state, { ...cookie, maxAge: 10 * 60_000 });
    res.cookie(returnCookie, studioReturnPath(req.body?.returnTo), {
      ...cookie,
      maxAge: 10 * 60_000,
    });
    res.json({ url });
  });
  router.get('/google/callback', async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    const saved = readSession(req, stateCookie);
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const destination = studioReturnPath(readSession(req, returnCookie));
    res.clearCookie(stateCookie, cookie);
    res.clearCookie(returnCookie, cookie);
    if (
      !auth.googleEnabled ||
      !saved ||
      Buffer.byteLength(saved) !== Buffer.byteLength(state) ||
      !timingSafeEqual(Buffer.from(saved), Buffer.from(state))
    )
      return res.redirect(`${auth.webOrigin}/sign-in?error=google`);
    try {
      const data = input(token, {
        userId: req.query.userId,
        secret: req.query.secret,
      });
      const session = await method('completeGoogle')(data.userId, data.secret);
      const expires = new Date(session.expiresAt);
      if (
        !session.secret ||
        !Number.isFinite(expires.getTime()) ||
        expires.getTime() <= Date.now()
      )
        throw new Error('Invalid session');
      clearAccountCookies(req, res, auth.secureCookies);
      res.cookie(sessionCookieName(auth), session.secret, {
        ...cookie,
        expires,
      });
      res.redirect(`${auth.webOrigin}${destination}`);
    } catch {
      res.redirect(`${auth.webOrigin}/sign-in?error=google`);
    }
  });
  router.delete('/', confirmationAttempts, async (req, res) => {
    const { user } = await authenticate(req, auth);
    const data = input(
      z
        .object({ password, confirmation: z.literal('DELETE'), emailCode })
        .strict(),
      req.body,
    );
    if (!store)
      throw new ApiError(
        503,
        'STORAGE_UNAVAILABLE',
        'Account data cannot be removed while storage is unavailable.',
      );
    const deleteUser = method('deleteUser');
    await method('verifyActionCode')(user, data.emailCode);
    const temporary = await provider().login({
      email: user.email,
      password: data.password,
    });
    try {
      if ((await provider().getUser(temporary.secret)).id !== user.id)
        throw new ApiError(
          403,
          'REAUTH_FAILED',
          'Please confirm your current password.',
        );
    } finally {
      await provider().logout(temporary.secret);
    }
    await withAccountLock(user.id, async () => {
      await lifecycle.beforeCleanup?.(user.id);
      const events = await store.list(user.id, 'event');
      for (const event of events)
        await store.put({ ...event, archived: true, visibility: 'private' });
      for (const photo of await store.list(user.id, 'photo')) {
        await store.removeFile(photo.id);
        await store.remove(photo.id);
      }
      for (const event of events) await store.remove(event.id);
      for (const job of await store.list(user.id, 'job'))
        await store.remove(job.id);
      await lifecycle.afterCleanup?.(user.id);
      await deleteUser(user.id);
      markDeletedAccount(user.id);
    });
    clearAccountCookies(req, res, auth.secureCookies);
    res.clearCookie(sessionCookieName(auth), cookie);
    res.status(204).end();
  });
  return router;
}
