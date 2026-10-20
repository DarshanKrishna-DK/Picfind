import { z } from 'zod';

export const qrPackFields = z
  .object({
    eventId: z.uuid(),
    destination: z.enum(['event', 'highlights']),
    heading: z.string().trim().min(1).max(80),
    instruction: z.string().trim().max(160),
    copies: z.union([z.literal(1), z.literal(2), z.literal(4)]),
  })
  .strict();
export type QrPackFields = z.infer<typeof qrPackFields>;

export function qrPackDestination(origin: string, input: QrPackFields) {
  const fields = qrPackFields.parse(input);
  const url = new URL(origin);
  const localPreview =
    ['localhost', '[::1]'].includes(url.hostname) ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (
    url.origin !== origin ||
    origin.length > 400 ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && localPreview))
  )
    throw new Error(
      'Use the deployed HTTPS site, or a loopback origin for a local preview.',
    );
  return {
    target: `${origin}/${fields.destination === 'event' ? 'e' : 'highlights'}/${fields.eventId}`,
    localPreview,
  };
}
export function escapeQrText(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
export function qrPackPrintHtml(
  input: QrPackFields,
  origin: string,
  png: string,
) {
  const fields = qrPackFields.parse(input);
  const destination = qrPackDestination(origin, fields);
  if (
    !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(png) ||
    png.length > 1_000_000
  )
    throw new Error('The QR image could not be prepared safely.');
  const notice = destination.localPreview
    ? 'Local preview only. Generate your guest pack from the deployed PicFind site.'
    : 'Sign in to view photos. An organizer access code may also be required.';
  const card = `<article><h1>${escapeQrText(fields.heading)}</h1><p>${escapeQrText(fields.instruction)}</p><img src="${png}" alt="QR code for the ${fields.destination === 'event' ? 'full event gallery' : 'published highlights'}"><p class="access">${notice}</p><p class="fallback">Or open:<br><a href="${escapeQrText(destination.target)}" rel="noreferrer">${escapeQrText(destination.target)}</a></p></article>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>PicFind printable QR pack</title>
<style>
@page { size: A4; margin: 10mm; }
* { box-sizing: border-box; }
body { margin: 0; font-family: Arial, sans-serif; color: #111; background: #fff; }
.sheet { display: grid; grid-template-columns: ${fields.copies === 4 ? '1fr 1fr' : '1fr'}; gap: 5mm; max-width: 190mm; margin: auto; }
article { border: 1px solid #555; padding: ${fields.copies === 4 ? 4 : 6}mm; text-align: center; break-inside: avoid; min-width: 0; }
h1 { font-size: ${fields.copies === 1 ? 22 : fields.copies === 2 ? 16 : 12}pt; margin: 0 0 2mm; overflow-wrap: anywhere; }
p { font-size: ${fields.copies === 4 ? 8 : 9}pt; line-height: 1.25; margin: 2mm 0; overflow-wrap: anywhere; }
img { display: block; width: ${fields.copies === 1 ? 100 : fields.copies === 2 ? 55 : 40}mm; max-width: 100%; height: auto; margin: auto; }
.fallback { font-size: ${fields.copies === 4 ? 6.5 : 8}pt; } a { color: #111; overflow-wrap: anywhere; }
.access { font-weight: bold; }
@media screen { body { padding: 10mm; background: #eee; } article { background: #fff; } }
</style></head><body><main class="sheet">${Array.from({ length: fields.copies }, () => card).join('')}</main></body></html>`;
}
