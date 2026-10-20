import {
  qrPackDestination,
  qrPackFields,
  qrPackPrintHtml,
  type QrPackFields,
} from '../../../packages/shared/src/qr-pack';

export async function prepareQrPack(
  origin: string,
  input: QrPackFields,
  signal: AbortSignal,
) {
  const fields = qrPackFields.parse(input);
  const destination = qrPackDestination(origin, fields);
  signal.throwIfAborted();
  const { toDataURL, toString } = await import('qrcode');
  const options = {
    margin: 4,
    width: 600,
    errorCorrectionLevel: 'M' as const,
    color: { dark: '#000000', light: '#ffffff' },
  };
  const png = await toDataURL(destination.target, options);
  signal.throwIfAborted();
  const svg = await toString(destination.target, { ...options, type: 'svg' });
  signal.throwIfAborted();
  const html = qrPackPrintHtml(fields, origin, png);
  const text = new TextEncoder();
  const binary = atob(png.slice(png.indexOf(',') + 1));
  const files = {
    'print.html': text.encode(html),
    'qr.png': Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    'qr.svg': text.encode(svg),
    'destination.json': text.encode(
      JSON.stringify(
        {
          version: 1,
          ...destination,
          eventId: fields.eventId,
          destination: fields.destination,
          heading: fields.heading,
          copies: fields.copies,
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    ),
    'instructions.txt': text.encode(
      [
        'PicFind printable QR pack',
        'Open print.html in your browser. Print on A4 or use the browser Save as PDF option.',
        'Keep the black on white QR and its surrounding white margin intact.',
        'The PNG and SVG are provided for a designer to place in other event material.',
        `Destination: ${destination.target}`,
        destination.localPreview
          ? 'LOCAL PREVIEW ONLY. This loopback link cannot be used by a guest on another device.'
          : 'Guests must sign in. The organizer may also require an access code.',
        'Printed links are static. Event expiry or withdrawn publication can make them unavailable.',
        'Check current access before distributing copies. No photos or passcodes are included in this pack.',
      ].join('\n'),
    ),
  };
  if (
    Object.values(files).reduce((size, bytes) => size + bytes.length, 0) >
    3_000_000
  )
    throw new Error(
      'The generated print pack exceeds the 3 MB limit. No download was started.',
    );
  return { files, png, ...destination };
}
