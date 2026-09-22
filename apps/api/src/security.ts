import type { Request, RequestHandler } from 'express';
import { ApiError, readSession, type AuthOptions } from './auth.js';
export const sessionCookieName = (auth: AuthOptions) =>
  auth.secureCookies ? '__Host-picfind_session' : 'picfind_session';
export async function authenticate(req: Request, auth: AuthOptions) {
  const secret = readSession(req, sessionCookieName(auth));
  if (!secret)
    throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in to continue.');
  if (!auth.provider)
    throw new ApiError(
      503,
      'AUTH_UNAVAILABLE',
      'Account access is not configured.',
    );
  return { secret, user: await auth.provider.getUser(secret) };
}
export function trustedOrigin(auth: AuthOptions): RequestHandler {
  return (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.vary('Origin');
    const origin = req.get('Origin');
    if (
      (origin && origin !== auth.webOrigin) ||
      (!['GET', 'HEAD'].includes(req.method) && origin !== auth.webOrigin)
    )
      return next(
        new ApiError(
          403,
          'ORIGIN_REJECTED',
          'A trusted request origin is required.',
        ),
      );
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, PATCH, DELETE, OPTIONS',
      );
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      return res.sendStatus(204);
    }
    next();
  };
}
