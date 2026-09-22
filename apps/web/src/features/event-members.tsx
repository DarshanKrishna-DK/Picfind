import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, type GalleryEvent, type Photo } from '../api';
import { ErrorNote, Loading, PageTitle } from '../components/ui';
import { PhotoGrid, UploadBox } from './gallery';
import { EventImportSources } from './event-import-sources';
import type { EventMemberView } from '../../../../packages/shared/src/event-membership';

export function EventMembersPanel({ eventId }: { eventId: string }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const query = useQuery({
    queryKey: ['event-members', eventId],
    queryFn: () =>
      api<{ members: EventMemberView[] }>(`/events/${eventId}/members`),
  });
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      await api(`/events/${eventId}/members`, {
        method: 'POST',
        body: JSON.stringify({
          email: String(new FormData(form).get('email') ?? '').trim(),
          role: 'moderator',
        }),
      });
      await client.invalidateQueries({ queryKey: ['event-members', eventId] });
      form.reset();
      setMessage(
        'Moderator added. This event is now available in their Studio.',
      );
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function remove(member: EventMemberView) {
    if (
      !window.confirm(`Remove ${member.name || member.email} from this event?`)
    )
      return;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      await api(
        `/events/${eventId}/members/${encodeURIComponent(member.userId)}`,
        { method: 'DELETE' },
      );
      await client.invalidateQueries({ queryKey: ['event-members', eventId] });
      setMessage('Moderator access removed.');
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="glass-panel settings-panel" aria-label="Event members">
      <h2>A little help, without handing over the keys.</h2>
      <p>
        Moderators can view, download and add photos to this event. They cannot
        delete photos, change sharing, manage members or access your billing.
        Cloud imports use each moderator's own connected account.
      </p>
      <form onSubmit={(event) => void invite(event)}>
        <label>
          Moderator email
          <input
            name="email"
            type="email"
            required
            maxLength={254}
            autoComplete="email"
            placeholder="photographer@example.com"
          />
        </label>
        <p className="field-help">
          Use the verified email of an existing PicFind account. Access appears
          directly in their Studio; no invitation email is sent.
        </p>
        <button className="button" disabled={busy}>
          {busy ? 'Saving...' : 'Add moderator'}
        </button>
      </form>
      <ErrorNote error={error || query.error} />
      <p role="status">{message}</p>
      {query.isPending ? (
        <Loading />
      ) : query.data?.members.length ? (
        <ul className="member-list">
          {query.data.members.map((member) => (
            <li key={member.userId}>
              <div>
                <strong>{member.name || 'Moderator'}</strong>
                <p>{member.email}</p>
                <small>Moderator</small>
              </div>
              <button
                className="button secondary compact"
                disabled={busy}
                onClick={() => void remove(member)}
                aria-label={`Remove ${member.name || member.email}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        !query.error && <p>No moderators yet. You remain the event owner.</p>
      )}
    </section>
  );
}

export function ModeratorEvent({ eventId }: { eventId: string }) {
  const query = useQuery({
    queryKey: ['event-gallery', eventId],
    retry: false,
    queryFn: () =>
      api<{ event: GalleryEvent; photos: Photo[]; remainingUploads: number }>(
        `/events/${eventId}/gallery`,
      ),
  });
  if (query.isPending) return <Loading />;
  if (query.error) return <ErrorNote error={query.error} />;
  const { event, photos, remainingUploads } = query.data;
  return (
    <>
      <Link className="text-link" to="/app/events">
        All events
      </Link>
      <PageTitle eyebrow="EVENT MODERATOR" title={event.title} />
      <p className="page-description">
        {event.description || 'Help collect the moments from this event.'}
      </p>
      <p className="notice">
        The organizer covers this event's usage. You can add photos and download
        the gallery. Only the owner can delete photos or change event settings.
      </p>
      <EventImportSources />
      <UploadBox eventId={eventId} remainingUploads={remainingUploads} />
      <PhotoGrid photos={photos} readOnly />
    </>
  );
}
