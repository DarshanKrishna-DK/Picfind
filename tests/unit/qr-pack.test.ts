import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import jsQR from 'jsqr';
import { prepareQrPack } from '../../apps/web/src/qr-pack';
import {
  qrPackDestination,
  qrPackFields,
  qrPackPrintHtml,
  type QrPackFields,
} from '../../packages/shared/src/qr-pack';

const fields: QrPackFields = {
  eventId: 'a15cfe6e-2ff0-4564-b83d-047d0eb2e673',
  destination: 'event',
  heading: 'Find your photos',
  instruction: 'Scan or open the link.',
  copies: 2,
};
async function decode(bytes: Uint8Array) {
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data;
}
describe('portable printable QR packs', () => {
  it.each([
    ['https://picfind.example.test', 'event'],
    ['https://picfind.example.test', 'highlights'],
    ['https://picfind.example.test', 'invitation'],
    ['http://127.0.0.1:5173', 'highlights'],
    [
      `https://${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.test`,
      'event',
    ],
  ] as const)(
    'decodes real PNG and SVG pixels to %s / %s',
    async (origin, destination) => {
      const pack = await prepareQrPack(
        origin,
        { ...fields, destination },
        new AbortController().signal,
      );
      const routes = {
        event: 'e',
        highlights: 'highlights',
        invitation: 'invite',
      };
      const target = `${origin}/${routes[destination]}/${fields.eventId}`;
      expect(await decode(pack.files['qr.png'])).toBe(target);
      expect(await decode(pack.files['qr.svg'])).toBe(target);
      expect(Object.keys(pack.files).sort()).toEqual([
        'destination.json',
        'instructions.txt',
        'print.html',
        'qr.png',
        'qr.svg',
      ]);
      expect(
        Object.values(pack.files).reduce(
          (total, bytes) => total + bytes.length,
          0,
        ),
      ).toBeLessThan(3_000_000);
      const manifest = JSON.parse(
        new TextDecoder().decode(pack.files['destination.json']),
      );
      expect(manifest).toMatchObject({
        version: 1,
        target,
        eventId: fields.eventId,
        destination,
        heading: fields.heading,
        copies: 2,
        localPreview: origin.startsWith('http:'),
      });
      expect(Object.keys(manifest).sort()).toEqual([
        'copies',
        'destination',
        'eventId',
        'generatedAt',
        'heading',
        'localPreview',
        'target',
        'version',
      ]);
      expect(
        new TextDecoder().decode(pack.files['instructions.txt']),
      ).toContain(target);
    },
  );
  it('prints public invitation access guidance without promising gallery access', async () => {
    const pack = await prepareQrPack(
      'https://picfind.example.test',
      { ...fields, destination: 'invitation' },
      new AbortController().signal,
    );
    const html = new TextDecoder().decode(pack.files['print.html']),
      instructions = new TextDecoder().decode(pack.files['instructions.txt']);
    expect(html).toContain('QR code for the published invitation');
    expect(html).toContain('Open the public invitation.');
    expect(html).toContain('does not grant access to event photos.');
    expect(html).not.toContain('Sign in to view photos.');
    expect(instructions).toContain('The invitation is public.');
    expect(instructions).not.toContain('Guests must sign in.');
  });
  it.each([1, 2, 4] as const)(
    'creates exactly %s safe printable cards',
    async (copies) => {
      const pack = await prepareQrPack(
        'https://picfind.example.test',
        {
          ...fields,
          copies,
          heading: '<img src=x onerror=alert(1)>',
          instruction: '</style><script>alert(1)</script>',
        },
        new AbortController().signal,
      );
      const html = new TextDecoder().decode(pack.files['print.html']);
      expect(html.match(/<article>/g)).toHaveLength(copies);
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('<img src=x');
      expect(html).toContain("default-src 'none'");
      expect(html).toContain('Sign in to view photos.');
      expect(html).not.toMatch(/<link|<iframe|<form|src="https?:/);
      expect(html).toContain(`href="${pack.target}"`);
    },
  );
  it.each(['http://localhost:5173', 'http://[::1]:5173', 'https://127.0.0.2'])(
    'labels %s as a local preview',
    (origin) => {
      expect(qrPackDestination(origin, fields).localPreview).toBe(true);
      expect(
        qrPackPrintHtml(fields, origin, 'data:image/png;base64,AAAA'),
      ).toContain('Local preview only.');
    },
  );
  it.each([
    'http://picfind.example.test',
    'http://192.168.1.2',
    'http://127.300.1.1',
    'https://127.999.999.999',
    'javascript:alert(1)',
    'https://user:password@example.test',
    'https://example.test/path',
    'https://example.test?next=outside',
    'https://example.test#fragment',
    'https://example.test/',
    'file:///local',
    'data:text/html,hello',
  ])('rejects non-origin or unsafe destination %s', (origin) => {
    expect(() => qrPackDestination(origin, fields)).toThrow();
  });
  it.each([
    { eventId: '../private' },
    { destination: 'arbitrary' },
    { heading: '' },
    { heading: 'a'.repeat(81) },
    { instruction: 'a'.repeat(161) },
    { copies: 3 },
    { copies: '2' },
    { target: 'https://outside.test' },
  ])('rejects invalid print input %j', (changes) => {
    expect(qrPackFields.safeParse({ ...fields, ...changes }).success).toBe(
      false,
    );
  });
  it('rejects a non-PNG data URL and cancels work before returning an artifact', async () => {
    expect(() =>
      qrPackPrintHtml(
        fields,
        'https://picfind.example.test',
        'data:image/svg+xml,<svg onload="alert(1)">',
      ),
    ).toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareQrPack('https://picfind.example.test', fields, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
