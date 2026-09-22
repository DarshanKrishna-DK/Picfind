import { Router, type CookieOptions, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { clearAccountCookies } from './connection-cookies.js';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
}

export interface AuthenticationProvider {
  register(input: {
    name: string;
    email: string;
    password: string;
  }): Promise<AuthUser>;
  login(input: {
    email: string;
    password: string;
  }): Promise<{ secret: string; expiresAt: string }>;
  getUser(secret: string): Promise<AuthUser>;
  logout(secret: string): Promise<void>;
  recover?(email: string, url: string): Promise<void>;
  resetPassword?(input: {
    userId: string;
    secret: string;
    password: string;
  }): Promise<void>;
  sendVerification?(secret: string, url: string): Promise<void>;
  verifyEmail?(input: { userId: string; secret: string }): Promise<void>;
  updateName?(secret: string, name: string): Promise<AuthUser>;
  changePassword?(
    secret: string,
    oldPassword: string,
    password: string,
  ): Promise<void>;
  revokeOtherSessions?(secret: string): Promise<void>;
  beginGoogle?(success: string, failure: string): Promise<string>;
  completeGoogle?(
    userId: string,
    secret: string,
  ): Promise<{ secret: string; expiresAt: string }>;
  deleteUser?(userId: string): Promise<void>;
  sendActionCode?(user: AuthUser): Promise<void>;
  verifyActionCode?(user: AuthUser, code: string): Promise<void>;
  resolveEventMember?(email: string): Promise<AuthUser | null>;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AuthOptions {
  provider?: AuthenticationProvider;
  webOrigin: string;
  secureCookies: boolean;
  googleEnabled?: boolean;
}

const credentials = z
  .object({ email: z.email().max(320), password: z.string().min(8).max(256) })
  .strict();
const registration = credentials.extend({
  name: z.string().trim().min(1).max(128),
});

export function readSession(
  req: Request,
  cookieName: string,
): string | undefined {
  const entries = (req.headers.cookie ?? '')
    .split(';')
    .map((entry) => entry.trim());
  const matching = entries.filter((entry) =>
    entry.startsWith(`${cookieName}=`),
  );
  if (matching.length > 1)
    throw new ApiError(400, 'INVALID_COOKIE', 'The session cookie is invalid.');
  if (!matching[0]) return undefined;
  try {
    const secret = decodeURIComponent(matching[0].slice(cookieName.length + 1));
    if (
      !secret ||
      secret.length > 4096 ||
      Array.from(secret).some(
        (character) =>
          character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new Error();
    return secret;
  } catch {
    throw new ApiError(400, 'INVALID_COOKIE', 'The session cookie is invalid.');
  }
}

export function createAuthRouter(options: AuthOptions) {
  const router = Router();
  const cookieName = options.secureCookies
    ? '__Host-picfind_session'
    : 'picfind_session';
  const cookie: CookieOptions = {
    httpOnly: true,
    secure: options.secureCookies,
    sameSite: 'lax',
    path: '/',
  };
  const getProvider = () => {
    if (!options.provider)
      throw new ApiError(
        503,
        'AUTH_UNAVAILABLE',
        'Account access is not configured yet.',
      );
    return options.provider;
  };
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.vary('Origin');
    const origin = req.get('Origin');
    if (origin && origin !== options.webOrigin) {
      return next(
        new ApiError(
          403,
          'ORIGIN_REJECTED',
          'This request origin is not allowed.',
        ),
      );
    }
    if (origin === options.webOrigin) {
      res.setHeader('Access-Control-Allow-Origin', options.webOrigin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') {
      if (!origin)
        return next(
          new ApiError(403, 'ORIGIN_REJECTED', 'A request origin is required.'),
        );
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, DELETE, OPTIONS',
      );
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      return res.sendStatus(204);
    }
    if (!['GET', 'HEAD'].includes(req.method) && origin !== options.webOrigin) {
      return next(
        new ApiError(
          403,
          'ORIGIN_REJECTED',
          'A trusted request origin is required.',
        ),
      );
    }
    next();
  });
  const limitHandler = (_req: Request, res: import('express').Response) => {
    res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message: 'Please wait before trying again.',
        requestId: res.locals.requestId,
      },
    });
  };
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: 60,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: limitHandler,
    }),
  );
  const mutationLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: limitHandler,
  });
  router.post('/register', mutationLimit, async (req, res) => {
    const input = registration.safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_INPUT',
        'Enter a name, valid email address, and a password of 8 to 256 characters.',
      );
    const user = await getProvider().register(input.data);
    res.status(201).json({ user });
  });
  router.post('/session', mutationLimit, async (req, res) => {
    const input = credentials.safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_INPUT',
        'Enter a valid email address and password.',
      );
    const session = await getProvider().login(input.data);
    const expires = new Date(session.expiresAt);
    if (
      !session.secret ||
      !Number.isFinite(expires.getTime()) ||
      expires.getTime() <= Date.now()
    ) {
      throw new ApiError(
        502,
        'AUTH_RESPONSE_INVALID',
        'The account service did not return a valid session.',
      );
    }
    clearAccountCookies(req, res, options.secureCookies);
    res.cookie(cookieName, session.secret, { ...cookie, expires });
    res.status(204).end();
  });
  router.get('/session', async (req, res) => {
    const secret = readSession(req, cookieName);
    if (!secret)
      throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in to continue.');
    try {
      res.json({ user: await getProvider().getUser(secret) });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        clearAccountCookies(req, res, options.secureCookies);
        res.clearCookie(cookieName, cookie);
      }
      throw error;
    }
  });
  router.delete('/session', mutationLimit, async (req, res) => {
    const secret = readSession(req, cookieName);
    try {
      if (secret) await getProvider().logout(secret);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) throw error;
    } finally {
      clearAccountCookies(req, res, options.secureCookies);
      res.clearCookie(cookieName, cookie);
    }
    res.status(204).end();
  });
  return router;
}
