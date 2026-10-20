import { useQuery } from '@tanstack/react-query';
import { api, HttpError, session } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import {
  eventReadiness,
  type EventReadiness,
} from '../../../../packages/shared/src/event-readiness';
import './event-readiness.css';

type Section = 'photos' | 'sharing' | 'highlights' | 'settings';
const galleryText: Record<EventReadiness['gallery']['state'], string> = {
  private: 'Full gallery is private',
  shared: 'Full gallery link sharing is enabled',
  archived: 'Event is archived',
  expired: 'Event retention has expired or needs repair',
  deleting: 'Event deletion is in progress',
};
const matchingText: Record<
  NonNullable<EventReadiness['matching']>['status'],
  string
> = {
  empty: 'Add photos before preparing face search',
  unavailable: 'Face search provider is not configured',
  processing: 'Face preparation is queued or running',
  'not-prepared': 'Photos are waiting for face preparation',
  partial: 'Some photos are prepared',
  ready: 'Saved face preparation is ready',
  'no-faces': 'No faces were found in prepared photos',
  'needs-attention': 'Face preparation needs attention',
  archived: 'Face search is unavailable for this archived event',
  expired: 'Face search is unavailable after event expiry',
  deleting: 'Face search is unavailable during deletion',
};
const highlightText: Record<EventReadiness['highlights']['state'], string> = {
  none: 'No curated highlights saved',
  draft: 'Highlights are a private draft',
  published: 'All selected highlights are available to signed-in guests',
  partial: 'Published highlights contain unavailable photos',
  unavailable: 'Published highlights cannot currently be delivered',
  invalid: 'Highlight metadata needs repair',
};
export function EventDayReadiness({
  eventId,
  onAction,
}: {
  eventId: string;
  onAction: (section: Section) => void;
}) {
  const account = useQuery({ queryKey: ['session'], queryFn: session });
  if (account.isPending) return <Loading />;
  if (!account.data || account.error)
    return (
      <ErrorNote
        error={account.error ?? new Error('Sign in to check this event.')}
      />
    );
  return (
    <Snapshot
      key={`${account.data.id}:${eventId}`}
      eventId={eventId}
      accountId={account.data.id}
      onAction={onAction}
    />
  );
}
function Snapshot({
  accountId,
  eventId,
  onAction,
}: {
  accountId: string;
  eventId: string;
  onAction: (section: Section) => void;
}) {
  const query = useQuery({
    queryKey: ['event-day-readiness', accountId, eventId],
    queryFn: async ({ signal }) => {
      const value = eventReadiness.parse(
        await api(`/events/${eventId}/readiness`, {
          signal,
          headers: { 'X-PicFind-Readiness-Actor': accountId },
        }),
      );
      if (value.accountId !== accountId || value.eventId !== eventId)
        throw new HttpError(
          403,
          'This readiness response belongs to another account or event. Reload the event.',
        );
      return value;
    },
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: true,
  });
  const value = query.data;
  return (
    <section
      className="glass-panel event-day-readiness"
      aria-label="Event day readiness"
    >
      <div className="event-readiness-heading">
        <h2>Event day readiness</h2>
        <button
          className="button secondary"
          type="button"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? 'Checking event...' : 'Refresh event readiness'}
        </button>
      </div>
      <p>
        A snapshot of saved event state. Each section has its own access rules.
        Nothing is published, imported or processed by this check.
      </p>
      {query.isFetching || query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorNote error={query.error} />
      ) : (
        value && (
          <>
            <p>
              Checked{' '}
              <time dateTime={value.checkedAt}>
                {new Date(value.checkedAt).toLocaleString()}
              </time>
              . Refresh after changes in another tab.
            </p>
            {value.worker === 'unavailable' && (
              <p role="alert">
                Worker status is unavailable. Import and face-processing
                readiness cannot be confirmed.
              </p>
            )}
            <div className="event-readiness-grid">
              <article aria-label="Gallery access check">
                <h3>Gallery access</h3>
                <p>
                  <strong>{galleryText[value.gallery.state]}</strong>
                </p>
                <p>
                  {value.gallery.hasPasscode
                    ? 'An event passcode is set.'
                    : 'No event passcode is set.'}{' '}
                  Guests still sign in.
                </p>
                <p>
                  {value.gallery.expiresAt
                    ? `Saved retention expiry: ${new Date(value.gallery.expiresAt).toLocaleString()}.`
                    : 'No valid retention expiry is saved.'}
                </p>
                <button
                  className="button secondary"
                  type="button"
                  onClick={() =>
                    onAction(
                      value.gallery.state === 'expired' ||
                        value.gallery.state === 'archived'
                        ? 'settings'
                        : 'sharing',
                    )
                  }
                >
                  Review gallery access
                </button>
              </article>
              <article aria-label="Photo storage check">
                <h3>Photos and saved storage</h3>
                <dl>
                  <dt>Available photos</dt>
                  <dd>{value.photos.available}</dd>
                  <dt>Expired or invalid retention</dt>
                  <dd>{value.photos.expired}</dd>
                  <dt>Deleting or removed records</dt>
                  <dd>{value.photos.deleting}</dd>
                  <dt>Known saved bytes</dt>
                  <dd>{value.photos.knownBytes.toLocaleString()}</dd>
                  <dt>Available photos with unknown size</dt>
                  <dd>{value.photos.unknownBytes}</dd>
                </dl>
                <p>
                  Saved byte metadata is not your remaining billing allowance.
                </p>
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => onAction('photos')}
                >
                  Review event photos
                </button>
              </article>
              <article aria-label="Import progress check">
                <h3>Event imports</h3>
                <dl>
                  <dt>Saved import batches</dt>
                  <dd>{value.imports.total}</dd>
                  <dt>Queued or running</dt>
                  <dd>{value.imports.running}</dd>
                  <dt>Complete</dt>
                  <dd>{value.imports.complete}</dd>
                  <dt>Partial</dt>
                  <dd>{value.imports.partial}</dd>
                  <dt>Failed, paused or interrupted</dt>
                  <dd>{value.imports.failed}</dd>
                  <dt>Unknown status</dt>
                  <dd>{value.imports.unknown}</dd>
                </dl>
                {value.imports.unknown > 0 && (
                  <p>
                    Some saved batches need a worker status check before
                    progress can be confirmed.
                  </p>
                )}
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => onAction('photos')}
                >
                  Review event imports
                </button>
              </article>
              <article aria-label="Face preparation check">
                <h3>Face preparation</h3>
                {value.matching ? (
                  <>
                    <p>
                      <strong>{matchingText[value.matching.status]}</strong>
                    </p>
                    <dl>
                      <dt>Prepared photos</dt>
                      <dd>{value.matching.counts.prepared}</dd>
                      <dt>No faces found</dt>
                      <dd>{value.matching.counts.noFaces}</dd>
                      <dt>Waiting</dt>
                      <dd>{value.matching.counts.waiting}</dd>
                      <dt>Failed</dt>
                      <dd>{value.matching.counts.failed}</dd>
                      <dt>Metadata needs review</dt>
                      <dd>{value.matching.counts.needsReview}</dd>
                      <dt>Uncertain prior attempts</dt>
                      <dd>{value.matching.uncertain}</dd>
                    </dl>
                    <p>
                      {value.matching.processingAvailable
                        ? 'Background face preparation is configured.'
                        : 'Background face preparation is not available in this deployment.'}
                    </p>
                  </>
                ) : (
                  <p>
                    Processing status is unavailable. Refresh when the worker
                    status service recovers.
                  </p>
                )}
                <p>
                  Preparation metadata does not guarantee that every guest will
                  find a match.
                </p>
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => onAction('sharing')}
                >
                  Review face preparation
                </button>
              </article>
              <article aria-label="Highlight delivery check">
                <h3>Curated highlights</h3>
                <p>
                  <strong>{highlightText[value.highlights.state]}</strong>
                </p>
                <dl>
                  <dt>Selected photos</dt>
                  <dd>{value.highlights.selected}</dd>
                  <dt>Currently available</dt>
                  <dd>{value.highlights.available}</dd>
                </dl>
                <p>
                  Highlight publication is independent of full-gallery sharing.
                </p>
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => onAction('highlights')}
                >
                  Review highlights
                </button>
              </article>
            </div>
          </>
        )
      )}
    </section>
  );
}
