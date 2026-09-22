import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import sharp from 'sharp';

test.use({
  baseURL: 'http://127.0.0.1:5173',
  // This opt-in diagnostic uses real credentials. Never capture authentication
  // request bodies or private account pages in retained browser artifacts.
  trace: 'off',
  screenshot: 'off',
  video: 'off',
});

test('opt-in Appwrite gallery: signed-in guest, download, revoke and owned cleanup', async ({
  page,
  browser,
  request,
}, testInfo) => {
  test.skip(
    process.env.PICFIND_LIVE_TEST !== '1' ||
      testInfo.project.name !== 'chromium',
    'Explicit live opt-in, Chromium only. No AWS or payment calls.',
  );
  test.setTimeout(180_000);
  const ownerEmail = process.env.PICFIND_LIVE_OWNER_EMAIL;
  const ownerPassword = process.env.PICFIND_LIVE_OWNER_PASSWORD;
  const guestEmail = process.env.PICFIND_LIVE_GUEST_EMAIL;
  const guestPassword = process.env.PICFIND_LIVE_GUEST_PASSWORD;
  expect(
    Boolean(ownerEmail && ownerPassword && guestEmail && guestPassword),
    'Provide two dedicated existing test accounts; the owner needs organizer entitlement. No accounts are created or deleted by this diagnostic.',
  ).toBe(true);
  const origin = 'http://127.0.0.1:5173';
  const capabilities = await request.get(`${origin}/api/capabilities`);
  expect(capabilities.status()).toBe(200);
  expect(
    (await capabilities.json()).faceMatching,
    'Run this diagnostic against a safe-mode API.',
  ).toBe(false);

  const guestContext = await browser.newContext({ baseURL: origin });
  const guest = await guestContext.newPage();
  const title = `PicFind live diagnostic ${randomUUID()}`;
  let eventId: string | undefined;
  let creationAttempted = false;
  let ownerLoggedIn = false;
  let guestLoggedIn = false;
  try {
    const ownerLogin = await page.request.post('/api/auth/session', {
      headers: { Origin: origin },
      data: { email: ownerEmail, password: ownerPassword },
    });
    expect(ownerLogin.status(), 'Owner test-account sign-in').toBe(204);
    ownerLoggedIn = true;
    const guestLogin = await guest.request.post('/api/auth/session', {
      headers: { Origin: origin },
      data: { email: guestEmail, password: guestPassword },
    });
    expect(guestLogin.status(), 'Guest test-account sign-in').toBe(204);
    guestLoggedIn = true;
    const ownerIdentity = await page.request.get('/api/auth/session');
    const guestIdentity = await guest.request.get('/api/auth/session');
    expect(ownerIdentity.status()).toBe(200);
    expect(guestIdentity.status()).toBe(200);
    const ownerId = (await ownerIdentity.json()).user.id;
    const guestId = (await guestIdentity.json()).user.id;
    expect(typeof ownerId).toBe('string');
    expect(typeof guestId).toBe('string');
    expect(ownerId, 'Use separate organizer and guest accounts').not.toBe(
      guestId,
    );

    creationAttempted = true;
    const created = await page.request.post('/api/events', {
      headers: { Origin: origin },
      data: {
        title,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
    });
    expect(
      created.status(),
      'The dedicated owner needs organizer event capacity',
    ).toBe(201);
    eventId = (await created.json()).event.id;
    expect(eventId).toMatch(/^[a-f0-9-]{36}$/);
    const path = `/api/public/events/${eventId}`;
    // Signed-in guests cannot see a private event; anonymous requests never get photos.
    expect((await guest.request.get(path)).status()).toBe(404);
    expect((await request.get(`${origin}${path}`)).status()).toBe(401);

    await page.goto(`/app/events/${eventId}`);
    const buffer = await sharp({
      create: { width: 640, height: 480, channels: 3, background: '#287f83' },
    })
      .jpeg()
      .toBuffer();
    await page.getByLabel('Choose photos', { exact: true }).setInputFiles({
      name: 'gallery-test.jpg',
      mimeType: 'image/jpeg',
      buffer,
    });
    await expect(
      page.getByRole('button', { name: 'Open gallery-test.jpg' }),
    ).toBeVisible({ timeout: 30_000 });
    const shared = await page.request.patch(`/api/events/${eventId}`, {
      headers: { Origin: origin },
      data: { visibility: 'link' },
    });
    expect(shared.status()).toBe(200);
    const gallery = await guest.request.get(path);
    expect(gallery.status()).toBe(200);
    const photos = (await gallery.json()).photos as { id: string }[];
    expect(photos).toHaveLength(1);
    const photoId = photos[0]!.id;
    expect((await request.get(`${origin}${path}`)).status()).toBe(401);
    expect(
      (await guest.request.get(`/api/photos/${photoId}/file`)).status(),
    ).toBe(404);
    const photo = await guest.request.get(`${path}/photos/${photoId}`);
    expect(photo.status()).toBe(200);
    expect(photo.headers()['content-type']).toContain('image/jpeg');
    expect(
      (
        await guest.request.patch(`/api/events/${eventId}`, {
          headers: { Origin: origin },
          data: { title: 'Not permitted' },
        })
      ).status(),
    ).toBe(404);

    await guest.goto(`/e/${eventId}`);
    await expect(
      guest.getByRole('button', { name: 'Open gallery-test.jpg' }),
    ).toBeVisible({ timeout: 30_000 });
    await guest
      .getByRole('checkbox', { name: 'Select gallery-test.jpg' })
      .check();
    const download = guest.waitForEvent('download');
    await guest.getByRole('button', { name: /^Download selected/ }).click();
    expect((await download).suggestedFilename()).toBe('picfind-photos.zip');
    expect(
      (
        await page.request.patch(`/api/events/${eventId}`, {
          headers: { Origin: origin },
          data: { visibility: 'private' },
        })
      ).status(),
    ).toBe(200);
    expect(
      (await guest.request.get(`${path}/photos/${photoId}`)).status(),
    ).toBe(404);
  } finally {
    try {
      if (creationAttempted && !eventId) {
        // Recover a lost create response by the unique diagnostic title, not by
        // deleting arbitrary data from the supplied organizer account.
        const library = await page.request.get('/api/library');
        expect(
          library.status(),
          'Resolve diagnostic event before cleanup',
        ).toBe(200);
        const matches = (
          (await library.json()).events as { id: string; title: string }[]
        ).filter((event) => event.title === title);
        expect(
          matches.length,
          'Unique diagnostic event title',
        ).toBeLessThanOrEqual(1);
        eventId = matches[0]?.id;
      }
      if (eventId) {
        const cleanup = await page.request.delete(`/api/events/${eventId}`, {
          headers: { Origin: origin },
        });
        expect(
          cleanup.status(),
          `Remove diagnostic gallery ${eventId} and its image`,
        ).toBe(204);
      }
    } finally {
      try {
        if (ownerLoggedIn) {
          const logout = await page.request.delete('/api/auth/session', {
            headers: { Origin: origin },
          });
          expect(logout.status(), 'End diagnostic owner session').toBe(204);
        }
      } finally {
        try {
          if (guestLoggedIn) {
            const logout = await guest.request.delete('/api/auth/session', {
              headers: { Origin: origin },
            });
            expect(logout.status(), 'End diagnostic guest session').toBe(204);
          }
        } finally {
          await guestContext.close();
        }
      }
    }
  }
});
