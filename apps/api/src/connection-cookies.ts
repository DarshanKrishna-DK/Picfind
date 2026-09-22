import type { Request, Response } from 'express';

/** Provider connections belong to one signed-in account, never the browser. */
export function clearAccountCookies(
  req: Request,
  res: Response,
  secure: boolean,
): void {
  const names = new Set(
    (req.headers.cookie ?? '')
      .split(';')
      .map((entry) => entry.trim().split('=', 1)[0] ?? ''),
  );
  const written = [res.getHeader('Set-Cookie') ?? []].flat().map(String);
  for (const name of names) {
    if (!/^(?:__Host-)?picfind_[A-Za-z0-9_-]{1,128}$/.test(name)) continue;
    if (written.some((value) => value.startsWith(`${name}=;`))) continue;
    res.clearCookie(name, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: secure || name.startsWith('__Host-'),
    });
  }
}
