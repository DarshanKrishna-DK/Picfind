import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { api, saveFile, session } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import { prepareQrPack } from '../qr-pack';
import { createGalleryArchive } from '../gallery-downloads';
import {
  qrPackFields,
  type QrPackFields,
} from '../../../../packages/shared/src/qr-pack';
import { storedHighlights } from '../../../../packages/shared/src/highlights';

const ownerEvent = z.object({
  id: z.uuid(),
  ownerId: z.string().min(1),
  kind: z.literal('event'),
  accessRole: z.literal('owner'),
  visibility: z.enum(['private', 'link']),
  archived: z.boolean().optional(),
  expiresAt: z.string().optional(),
  deletionStartedAt: z.string().optional(),
  deletionCompletedAt: z.string().optional(),
});
export function QrPrintPack({ eventId }: { eventId: string }) {
  const account = useQuery({ queryKey: ['session'], queryFn: session });
  if (account.isPending) return <Loading />;
  if (!account.data || account.error)
    return (
      <ErrorNote
        error={
          account.error ?? new Error('Sign in to prepare an owner print pack.')
        }
      />
    );
  return (
    <PrintPackEditor
      key={`${account.data.id}:${eventId}`}
      eventId={eventId}
      accountId={account.data.id}
    />
  );
}
function PrintPackEditor({
  eventId,
  accountId,
}: {
  eventId: string;
  accountId: string;
}) {
  const [draft, setDraft] = useState<QrPackFields>({
    eventId,
    destination: 'event',
    heading: 'Find your event photos',
    instruction: 'Scan the code or open the link below to view the photos.',
    copies: 2,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<{
    png: string;
    target: string;
    localPreview: boolean;
  } | null>(null);
  const pending = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.abort();
    };
  }, []);
  function edit(changes: Partial<QrPackFields>) {
    setDraft((current) => ({ ...current, ...changes }));
    setPreview(null);
    setMessage('');
  }
  async function checkAccess(fields: QrPackFields, signal: AbortSignal) {
    if (fields.destination === 'highlights') {
      const result = await api<{ highlights: unknown }>(
        `/events/${encodeURIComponent(eventId)}/highlights`,
        { signal },
      );
      signal.throwIfAborted();
      const highlights = storedHighlights.safeParse(result.highlights);
      if (!highlights.success || !highlights.data.published)
        throw new Error(
          'Publish a highlight selection before preparing its print pack.',
        );
    }
    const response = await api<{ event: unknown }>(
      `/events/${encodeURIComponent(eventId)}/gallery`,
      { signal },
    );
    signal.throwIfAborted();
    const parsed = ownerEvent.safeParse(response.event);
    if (
      !parsed.success ||
      parsed.data.id !== eventId ||
      parsed.data.ownerId !== accountId
    )
      throw new Error(
        'This print pack is unavailable for the current account.',
      );
    const event = parsed.data;
    if (
      event.archived ||
      event.deletionStartedAt ||
      event.deletionCompletedAt ||
      (event.expiresAt && !(Date.parse(event.expiresAt) > Date.now()))
    )
      throw new Error(
        'Restore an open event before preparing a guest print pack.',
      );
    if (fields.destination === 'event') {
      if (event.visibility !== 'link')
        throw new Error(
          'Enable full gallery link sharing, or choose published highlights.',
        );
    }
  }
  async function generate() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    setMessage('');
    setPreview(null);
    try {
      const fields = qrPackFields.parse(draft);
      await checkAccess(fields, controller.signal);
      const pack = await prepareQrPack(
        window.location.origin,
        fields,
        controller.signal,
      );
      const archive = await createGalleryArchive(pack.files, controller.signal);
      await checkAccess(fields, controller.signal);
      controller.signal.throwIfAborted();
      saveFile(
        new Blob([new Uint8Array(archive)], { type: 'application/zip' }),
        `picfind-${fields.destination}-qr-pack.zip`,
      );
      setPreview({
        png: pack.png,
        target: pack.target,
        localPreview: pack.localPreview,
      });
      setMessage(
        'Print pack downloaded. Open print.html from the ZIP to print or save as PDF.',
      );
    } catch (failure) {
      if (mounted.current) {
        if (controller.signal.aborted)
          setMessage('Generation cancelled. No new pack was downloaded.');
        else setError(failure);
      }
    } finally {
      if (pending.current === controller) pending.current = null;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section aria-label="Printable QR pack">
      <h3>Printable QR pack</h3>
      <p>
        Prepare one, two or four cards for an A4 sheet, plus PNG and SVG files
        for your designer. Current sharing access is checked before download.
        This does not publish your gallery.
      </p>
      <p>
        Use the deployed public PicFind site for a guest-ready pack. Printed
        links can stop working after event expiry or withdrawn publication.
      </p>
      <ErrorNote error={error} />
      <fieldset disabled={busy}>
        <label>
          QR destination
          <select
            value={draft.destination}
            onChange={(event) =>
              edit({
                destination: event.target.value as QrPackFields['destination'],
              })
            }
          >
            <option value="event">Full event gallery</option>
            <option value="highlights">Published highlights only</option>
          </select>
        </label>
        <label>
          Printed heading
          <input
            maxLength={80}
            value={draft.heading}
            onChange={(event) => edit({ heading: event.target.value })}
          />
        </label>
        <label>
          Printed instruction
          <textarea
            maxLength={160}
            value={draft.instruction}
            onChange={(event) => edit({ instruction: event.target.value })}
          />
        </label>
        <label>
          Cards per A4 sheet
          <select
            value={draft.copies}
            onChange={(event) =>
              edit({
                copies: Number(event.target.value) as QrPackFields['copies'],
              })
            }
          >
            <option value="1">One card</option>
            <option value="2">Two cards</option>
            <option value="4">Four cards</option>
          </select>
        </label>
        <button
          type="button"
          className="button"
          disabled={!draft.heading.trim()}
          onClick={() => void generate()}
        >
          Generate print pack
        </button>
      </fieldset>
      {busy && (
        <button
          type="button"
          className="button secondary"
          onClick={() => pending.current?.abort()}
        >
          Cancel print pack
        </button>
      )}
      <p role="status">{message}</p>
      {preview && (
        <div>
          {preview.localPreview && (
            <p className="notice">
              Local preview only. This link will not work for a guest on another
              device.
            </p>
          )}
          <img
            src={preview.png}
            alt="Generated QR preview"
            width={240}
            height={240}
          />
          <label>
            Pack destination
            <input
              readOnly
              value={preview.target}
              onFocus={(event) => event.target.select()}
            />
          </label>
        </div>
      )}
    </section>
  );
}
