import { EventProcessing } from './processing';
import { EventMembersPanel, ModeratorEvent } from './event-members';
import { GalleryAccess, OrganizerTools } from './event-tools';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  Copy,
  ScanFace,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import {
  api,
  saveFile,
  type FaceMatch,
  type GalleryEvent,
  type Photo,
} from '../api';
import { useLibrary } from '../hooks';
import { ErrorNote, Loading, PageTitle, Empty } from '../components/ui';
import { UploadBox, PhotoGrid } from '../features/gallery';
import './organizer.css';
import type { OrganizerEventPolicy } from '../../../../packages/shared/src/event-policy';
import { ProofingCollections } from './proofing-collections';
import { RawJpegPairing } from './raw-jpeg-pairing';
import { HighlightsEditor } from './highlights';
import { QrPrintPack } from './qr-print-pack';
import { EventDayReadiness } from './event-readiness';
import { EventCoverage } from './event-coverage';
import { EventInvitationEditor } from './event-invitation-page';

export function EventForm({
  existing,
  introduction = '',
}: {
  existing?: GalleryEvent;
  introduction?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [requestId] = useState(() => crypto.randomUUID());
  const policy = useQuery({
    queryKey: ['organizer-event-policy'],
    queryFn: () => api<OrganizerEventPolicy>('/events/entitlement'),
    retry: false,
  });
  const library = useLibrary();
  const folderOptions = [
    ...new Set(
      (library.data?.events ?? []).flatMap((event) =>
        event.folder ? [event.folder] : [],
      ),
    ),
  ].sort();
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState('');
  const [description, setDescription] = useState(
    existing?.description ?? introduction,
  );
  useEffect(() => {
    if (!existing) setDescription(introduction);
  }, [existing, introduction]);
  const navigate = useNavigate();
  const client = useQueryClient();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    setSaved('');
    try {
      const selectedDate = String(form.get('expiry') ?? '');
      const maximum = policy.data?.maximumExpiresAt;
      const expiryChanged =
        !existing ||
        (selectedDate && selectedDate !== existing.expiresAt?.slice(0, 10));
      const expiresAt = selectedDate
        ? new Date(
            maximum && selectedDate === maximum.slice(0, 10)
              ? Math.min(
                  Date.parse(selectedDate + 'T23:59:59.999Z'),
                  Date.parse(maximum),
                )
              : Date.parse(selectedDate + 'T23:59:59.999Z'),
          ).toISOString()
        : '';
      // Some mobile date controls do not enforce max consistently. Keep the
      // server authoritative, but give the user an error before sending a write.
      if (expiryChanged) {
        const chosen = Date.parse(expiresAt);
        if (!Number.isFinite(chosen) || chosen <= Date.now())
          throw new Error('Choose a future gallery/storage expiry date.');
        if (!policy.data?.entitlement || !maximum)
          throw new Error(
            'An active organizer plan is required to change gallery retention.',
          );
        if (chosen > Date.parse(maximum))
          throw new Error(
            `Your plan allows up to ${policy.data.entitlement.retentionDays} days. Choose an earlier expiry date.`,
          );
      }
      const result = await api<{ event: GalleryEvent }>(
        existing ? `/events/${existing.id}` : '/events',
        {
          method: existing ? 'PATCH' : 'POST',
          body: JSON.stringify({
            ...(!existing ? { requestId } : {}),
            title: form.get('title'),
            folder: form.get('folder'),
            date: form.get('date'),
            description: form.get('description'),
            ...(expiryChanged ? { expiresAt } : {}),
          }),
        },
      );
      await client.invalidateQueries({ queryKey: ['library'] });
      await client.invalidateQueries({ queryKey: ['organizer-event-policy'] });
      if (!existing) navigate(`/app/events/${result.event.id}?created=1`);
      else setSaved('Event details saved.');
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  if (!existing && policy.isPending) return <Loading />;
  if (!existing && policy.error)
    return (
      <section className="glass-panel event-plan-gate">
        <h2>We could not check your event allowance.</h2>
        <ErrorNote error={policy.error} />
        <button
          className="button secondary"
          onClick={() => void policy.refetch()}
        >
          Check again
        </button>
      </section>
    );
  if (!existing && !policy.data?.canCreate)
    return (
      <section className="glass-panel event-plan-gate">
        <ShieldCheck size={28} />
        <h2>
          {policy.data?.entitlement
            ? 'Your live-event allowance is full.'
            : 'An organizer plan is required.'}
        </h2>
        <p>
          {policy.data?.entitlement
            ? `Your plan includes ${policy.data.entitlement.liveEvents} live events. Archive an event to make room, or choose a larger organizer plan.`
            : 'Personal photo packs are for finding your own photos. An organizer plan includes event hosting, photo processing and guest searches. Guests never pay to access your event.'}
        </p>
        <div className="actions">
          <Link className="button" to="/app/billing">
            Open Billing <ArrowRight size={17} />
          </Link>
          {policy.data?.entitlement && (
            <Link className="button secondary" to="/app/events">
              Manage events
            </Link>
          )}
        </div>
        {!policy.data?.catalogAvailable && (
          <p className="field-help">
            Organizer checkout is not available yet. No payment can be started.
          </p>
        )}
      </section>
    );
  return (
    <form className="event-form" onSubmit={(event) => void submit(event)}>
      <label>
        Event name
        <input
          name="title"
          defaultValue={existing?.title}
          required
          maxLength={120}
          placeholder="Give the occasion a name"
        />
      </label>
      <details className="event-folder-options">
        <summary>Optional private organization</summary>
        <label>
          Event folder (private)
          <input
            name="folder"
            maxLength={80}
            defaultValue={existing?.folder ?? ''}
            list="event-folder-options"
            placeholder="For example, Weddings 2026"
          />
          <datalist id="event-folder-options">
            {folderOptions.map((folder) => (
              <option key={folder} value={folder} />
            ))}
          </datalist>
          <span className="field-help">
            Optional. Only you see this label; photos always belong to this
            event.
          </span>
        </label>
      </details>
      <div className="form-pair">
        <label>
          Event date
          <input name="date" type="date" defaultValue={existing?.date} />
        </label>
        <label>
          Gallery/storage expires on
          <input
            name="expiry"
            type="date"
            required={!existing || Boolean(policy.data?.entitlement)}
            disabled={Boolean(existing && !policy.data?.entitlement)}
            min={policy.data?.serverNow.slice(0, 10)}
            max={policy.data?.maximumExpiresAt?.slice(0, 10)}
            defaultValue={existing?.expiresAt?.slice(0, 10)}
          />
          <span className="field-help">
            {policy.data?.entitlement
              ? `Your plan allows up to ${policy.data.entitlement.retentionDays} days. Dates use UTC; the final day ends at your plan limit.`
              : 'An active organizer plan is required to change gallery retention.'}
          </span>
        </label>
      </div>
      <label>
        A few words about the day
        <textarea
          name="description"
          rows={4}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={2000}
          placeholder="Set the scene for your guests."
        />
      </label>
      <p className="field-help">
        Events start private. Your link and QR code are ready immediately;
        enable sharing when you are ready.
      </p>
      <ErrorNote error={error} />
      <p role="status">{saved}</p>
      <button className="button" disabled={busy}>
        {busy ? 'Saving...' : existing ? 'Save details' : 'Create event'}
        <ArrowRight size={17} />
      </button>
    </form>
  );
}

export function NewEvent() {
  return (
    <>
      <PageTitle eyebrow="A NEW CHAPTER" title="Make it an occasion." />
      <p className="page-description">
        Start with the details. The photographs come next.
      </p>
      <EventForm />
    </>
  );
}

export function EventDetail() {
  const { eventId } = useParams();
  const [search] = useSearchParams();
  const query = useLibrary();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState('photos');
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const event = query.data?.events.find((row) => row.id === eventId);
  if (query.isPending) return <Loading />;
  if (query.error) return <ErrorNote error={query.error} />;
  if (!event)
    return (
      <Empty
        title="Event not found."
        text="This event is unavailable or belongs to another account."
      />
    );
  if (event.accessRole === 'moderator')
    return <ModeratorEvent eventId={event.id} />;
  const photos = query.data!.photos.filter(
    (photo) => photo.eventId === event.id,
  );
  const url = `${window.location.origin}/e/${event.id}`;
  async function update(body: object) {
    setBusy(true);
    setError(null);
    try {
      await api(`/events/${eventId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      await client.invalidateQueries({ queryKey: ['library'] });
      await client.invalidateQueries({ queryKey: ['organizer-event-policy'] });
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (
      !window.confirm('Permanently delete this event and all its photographs?')
    )
      return;
    setBusy(true);
    try {
      await api(`/events/${eventId}`, { method: 'DELETE' });
      await client.invalidateQueries({ queryKey: ['library'] });
      await client.invalidateQueries({ queryKey: ['organizer-event-policy'] });
      navigate('/app/events');
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function qr() {
    try {
      const { toString } = await import('qrcode');
      const svg = await toString(url, {
        type: 'svg',
        margin: 3,
        color: { dark: '#202427', light: '#ffffff' },
      });
      saveFile(
        new Blob([svg], { type: 'image/svg+xml' }),
        'picfind-event-qr.svg',
      );
    } catch (failure) {
      setError(failure);
    }
  }
  return (
    <>
      <Link className="text-link" to="/app/events">
        All events <ChevronRight size={16} />
      </Link>
      <PageTitle
        eyebrow={
          event.archived
            ? 'ARCHIVED EVENT'
            : event.visibility === 'link'
              ? 'SHARED EVENT'
              : 'PRIVATE EVENT'
        }
        title={event.title}
      />
      <p className="page-description">
        {event.description || 'A place for the moments from this occasion.'}
      </p>
      {!event.archived && (!photos.length || search.get('created') === '1') && (
        <section
          className="glass-panel event-first-run"
          aria-label="Event setup"
        >
          <div>
            <h2>Your gallery link is ready.</h2>
            <p>
              Add photographs to this event and share its gallery link. Guests
              sign in, but do not pay for event access.
            </p>
          </div>
          <label>
            Event gallery link
            <input readOnly value={url} onFocus={(e) => e.target.select()} />
          </label>
          <div className="actions">
            <button
              className="button secondary"
              onClick={() =>
                void navigator.clipboard
                  .writeText(url)
                  .then(() => setMessage('Link copied.'))
                  .catch(() =>
                    setMessage('Select and copy the gallery link above.'),
                  )
              }
            >
              <Copy size={16} />
              Copy gallery link
            </button>
            <button className="button secondary" onClick={() => void qr()}>
              <ArrowDownToLine size={16} />
              Download gallery QR
            </button>
            <button
              className="button"
              onClick={() => {
                setTab('photos');
                requestAnimationFrame(() =>
                  document
                    .getElementById('event-upload')
                    ?.scrollIntoView({ block: 'start' }),
                );
              }}
            >
              Add photos to this event <ArrowRight size={16} />
            </button>
          </div>
          <p className="field-help">
            {event.visibility === 'private'
              ? 'This gallery is still private. Open Sharing to enable gallery access, even before uploading photos.'
              : 'Gallery access is enabled. Keep this link private to your guests.'}
          </p>
          <p role="status">{message}</p>
        </section>
      )}
      <div className="tabs" role="tablist" aria-label="Event sections">
        {[
          'photos',
          'readiness',
          'coverage',
          'invitation',
          'collections',
          'editing',
          'highlights',
          'sharing',
          'members',
          'settings',
        ].map((value) => (
          <button
            role="tab"
            aria-selected={tab === value}
            key={value}
            onClick={() => {
              setTab(value);
              setError(null);
            }}
            className={tab === value ? 'active' : ''}
          >
            {value === 'photos'
              ? `Photos (${photos.length})`
              : value[0]!.toUpperCase() + value.slice(1)}
          </button>
        ))}
      </div>
      <ErrorNote error={error} />
      {tab === 'readiness' && (
        <EventDayReadiness
          key={event.id}
          eventId={event.id}
          onAction={setTab}
        />
      )}
      {tab === 'coverage' && (
        <EventCoverage key={event.id} eventId={event.id} photos={photos} />
      )}
      {tab === 'invitation' && (
        <EventInvitationEditor key={event.id} eventId={event.id} />
      )}
      {tab === 'photos' && (
        <>
          {!event.archived && (
            <div id="event-upload">
              <EventImportSources />
              <UploadBox eventId={event.id} />
            </div>
          )}
          <PhotoGrid photos={photos} privateNotes />
        </>
      )}
      {tab === 'collections' && (
        <ProofingCollections
          key={event.id}
          eventId={event.id}
          photos={photos}
        />
      )}
      {tab === 'editing' && (
        <RawJpegPairing key={event.id} eventId={event.id} />
      )}
      {tab === 'highlights' && (
        <HighlightsEditor key={event.id} eventId={event.id} photos={photos} />
      )}
      {tab === 'sharing' && (
        <div className="settings-panel">
          <ShieldCheck size={32} strokeWidth={1.3} />
          <h2>Let the story travel.</h2>
          <p>
            Signed-in guests with this secret link or QR code can see and
            download every photograph in this event. Only share photos you have
            permission to publish. Face matching, when enabled, uses Amazon
            Rekognition on a consented selfie and returns ranked match scores.
          </p>
          <p className="notice">
            {event.archived
              ? 'Restore the event to enable sharing.'
              : event.expiresAt && Date.parse(event.expiresAt) < Date.now()
                ? 'This event has expired. Update its expiry date to restore access.'
                : event.visibility === 'link'
                  ? 'Link sharing is on.'
                  : 'This event is private.'}
          </p>
          <EventProcessing
            eventId={event.id}
            photoCount={photos.length}
            archived={Boolean(event.archived)}
          />
          <button
            className="button"
            disabled={busy || event.archived}
            onClick={() => {
              if (
                event.visibility === 'link' ||
                window.confirm(
                  'Allow signed-in guests with this secret event link to view and download every photo?',
                )
              )
                void update({
                  visibility: event.visibility === 'link' ? 'private' : 'link',
                });
            }}
          >
            {event.visibility === 'link'
              ? 'Make private'
              : 'Enable link sharing'}
          </button>
          {event.visibility === 'link' && !event.archived && (
            <div className="sharing-tools">
              <label>
                Gallery link
                <input
                  readOnly
                  value={url}
                  onFocus={(event) => event.target.select()}
                />
              </label>
              <div className="actions">
                <button
                  className="button secondary"
                  onClick={() => {
                    if (navigator.share) {
                      void navigator
                        .share({
                          title: event.title,
                          text: 'View and download the event photos.',
                          url,
                        })
                        .catch((failure: unknown) => {
                          if (!(
                            failure instanceof Error &&
                            failure.name === 'AbortError'
                          ))
                            setMessage(
                              'Use Copy link below to share this gallery.',
                            );
                        });
                    } else {
                      void navigator.clipboard
                        .writeText(url)
                        .then(() =>
                          setMessage(
                            'Link copied. Paste it into your message.',
                          ),
                        )
                        .catch(() =>
                          setMessage('Select and copy the gallery link above.'),
                        );
                    }
                  }}
                >
                  Share gallery <ArrowUpRight size={16} />
                </button>
                <button
                  className="button secondary"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(url)
                      .then(() => setMessage('Link copied.'))
                      .catch(() =>
                        setMessage('Select and copy the link above.'),
                      )
                  }
                >
                  <Copy size={16} />
                  Copy link
                </button>
                <button className="button secondary" onClick={() => void qr()}>
                  <ArrowDownToLine size={16} />
                  Download QR code
                </button>
                <a
                  className="text-link"
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                >
                  View gallery <ArrowUpRight size={16} />
                </a>
              </div>
              <p role="status">{message}</p>
              <p className="field-help">
                For a QR code that works on another device, use a publicly
                reachable deployment URL.
              </p>
            </div>
          )}
        </div>
      )}
      {tab === 'sharing' && <QrPrintPack key={event.id} eventId={event.id} />}
      {tab === 'members' && <EventMembersPanel eventId={event.id} />}
      {tab === 'settings' && (
        <>
          <EventForm existing={event} />
          <div className="danger-zone">
            <h2>Manage this event</h2>
            <p>
              Archiving hides the shared gallery. Deleting also removes its
              stored photos.
            </p>
            <div className="actions">
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void update({ archived: !event.archived })}
              >
                {event.archived ? 'Restore event' : 'Archive event'}
              </button>
              <button
                className="button danger-outline"
                disabled={busy}
                onClick={() => void remove()}
              >
                <Trash2 size={16} />
                Delete event
              </button>
            </div>
          </div>
        </>
      )}
      <OrganizerTools eventId={eventId!} />
    </>
  );
}

function UnlockedSharedEvent() {
  const { eventId } = useParams();
  const query = useQuery({
    queryKey: ['public-event', eventId],
    queryFn: () =>
      api<{ event: GalleryEvent; photos: Photo[] }>(
        `/public/events/${eventId}`,
      ),
  });
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [matches, setMatches] = useState<FaceMatch[] | null>(null);
  async function find(file: File) {
    if (!consent) {
      setError(new Error('Confirm the face-matching notice first.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ matches: FaceMatch[] }>(
        `/public/events/${eventId}/find`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-PicFind-Consent': 'face-matching-v1',
            'X-File-Name': encodeURIComponent(file.name),
          },
          body: file,
        },
      );
      setMatches(result.matches);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="wrap standalone shared-event">
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <>
          <PageTitle
            eyebrow="EVENT GALLERY"
            title="This gallery is unavailable."
          />
          <ErrorNote error={query.error} />
        </>
      ) : (
        <>
          <PageTitle
            eyebrow="A SHARED PICFIND GALLERY"
            title={query.data!.event.title}
          />
          <p className="lede">{query.data!.event.description}</p>
          <p className="collection-meta">
            {query.data!.event.date} / {query.data!.photos.length} photographs
          </p>
          <form
            className="import-panel"
            onSubmit={(event) => {
              event.preventDefault();
              const input = event.currentTarget.elements.namedItem(
                'selfie',
              ) as HTMLInputElement;
              const file = input.files?.[0];
              if (file) void find(file);
            }}
          >
            <ScanFace size={26} />
            <div>
              <h2>Find my photos</h2>
              <p>
                Amazon Rekognition will process one selfie to rank photos that
                may contain the same face. Match scores are similarity, not
                guaranteed accuracy. The selfie is not stored.
              </p>
              <label className="consent-line">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                I agree to face matching for this event.
              </label>
              <label>
                Reference selfie
                <input
                  name="selfie"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  required
                />
              </label>
              <button className="button" disabled={busy || !consent}>
                {busy ? 'Searching...' : 'Search this gallery'}
              </button>
            </div>
          </form>
          <ErrorNote error={error} />
          {matches && (
            <p role="status">
              {matches.length
                ? `${matches.length} ranked match(es).`
                : 'No photos met the configured match-score threshold.'}
            </p>
          )}
          {matches !== null ? (
            <section aria-label="Matched photos">
              <div className="gallery-summary">
                <h2>Your likely matches</h2>
                <button
                  className="button secondary compact"
                  onClick={() => setMatches(null)}
                >
                  Show all event photos
                </button>
              </div>
              {matches.length ? (
                <>
                  <PhotoGrid
                    preserveOrder
                    photos={matches.map(
                      (match) =>
                        query.data!.photos.find(
                          (photo) => photo.id === match.photoId,
                        ) ?? {
                          id: match.photoId,
                          filename: match.filename,
                          width: match.width ?? 1200,
                          height: match.height ?? 900,
                          bytes: 0,
                          createdAt: '',
                        },
                    )}
                    eventId={eventId!}
                    readOnly
                  />
                  <details className="download-help">
                    <summary>View similarity scores</summary>
                    <ul>
                      {matches.map((match) => (
                        <li key={match.photoId}>
                          {match.filename}: {match.similarity.toFixed(1)} / 100
                        </li>
                      ))}
                    </ul>
                  </details>
                </>
              ) : (
                <p>
                  No likely matches were found. Try a clearer reference photo,
                  or choose Show all event photos to browse the gallery.
                </p>
              )}
            </section>
          ) : (
            <PhotoGrid
              photos={query.data!.photos}
              eventId={eventId!}
              readOnly
            />
          )}
        </>
      )}
    </section>
  );
}

export function SharedEvent() {
  const { eventId } = useParams();
  return (
    <GalleryAccess eventId={eventId!}>
      <UnlockedSharedEvent />
    </GalleryAccess>
  );
}
import { EventImportSources } from './event-import-sources';
