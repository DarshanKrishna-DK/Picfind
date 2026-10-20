import type { MatchingReadiness } from '../../../../packages/shared/src/matching-readiness';

const messages: Record<MatchingReadiness['status'], [string, string]> = {
  empty: [
    'Add photos to begin',
    'Upload or import photographs into this event.',
  ],
  unavailable: [
    'Face search is unavailable',
    'Saved preparation results are shown below. Face search needs to be restored on this deployment before guests can use it.',
  ],
  processing: [
    'Face search is being prepared',
    'Preparation is in progress. Completed photographs can become searchable before the full batch finishes.',
  ],
  'not-prepared': [
    'Photos are waiting for preparation',
    'Review the consent below before starting face processing.',
  ],
  partial: [
    'Some photos are prepared',
    'New or unprocessed photographs are still waiting. Prepare them to include them in face search.',
  ],
  ready: [
    'Available photos are prepared',
    'Preparation is complete for the available photographs. This does not guarantee a match for every guest.',
  ],
  'no-faces': [
    'No searchable faces were found',
    'Processing finished without searchable faces. Guests can still browse the shared gallery. Repeating the same photos may not improve the result.',
  ],
  'needs-attention': [
    'Some photos need attention',
    'Review the counts and the latest processing run before starting another attempt.',
  ],
  archived: [
    'This event is archived',
    'Guest access is closed. Restore the event before preparing or sharing it.',
  ],
  expired: [
    'This event has expired',
    'Guest access is closed. Review storage expiry and your event allowance in Settings.',
  ],
  deleting: [
    'Event deletion is in progress',
    'Guest access is closed. Finish deletion before preparing another gallery.',
  ],
};

export function MatchingReadinessPanel({
  snapshot,
  refresh,
  refreshing,
}: {
  snapshot: MatchingReadiness;
  refresh: () => void;
  refreshing: boolean;
}) {
  const [heading, message] = messages[snapshot.status];
  return (
    <section className="matching-readiness" aria-label="Face search readiness">
      <div className="processing-status">
        <h4>{heading}</h4>
        <button
          type="button"
          className="button secondary compact"
          disabled={refreshing}
          onClick={refresh}
        >
          {refreshing ? 'Checking readiness...' : 'Refresh readiness'}
        </button>
      </div>
      <p>{message}</p>
      <dl className="readiness-counts">
        {(
          [
            ['Prepared', snapshot.counts.prepared],
            ['No searchable faces', snapshot.counts.noFaces],
            ['Waiting', snapshot.counts.waiting],
            ['Failed', snapshot.counts.failed],
            ['Needs review', snapshot.counts.needsReview],
          ] as const
        ).map(([label, count]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{count}</dd>
          </div>
        ))}
      </dl>
      <p className="field-help">
        {snapshot.counts.total} available photographs. Expired and deleting
        photographs are excluded.
        {snapshot.gallery === 'private' &&
          ' This gallery is private. Enable sharing when you are ready.'}
      </p>
      {snapshot.counts.needsReview > 0 && (
        <p className="notice">
          Some saved preparation records are incomplete or belong to another
          face provider. Contact support before reprocessing these photos.
        </p>
      )}
      {snapshot.uncertain > 0 && snapshot.status !== 'processing' && (
        <p className="notice">
          {snapshot.uncertain} photographs have an unresolved processing
          attempt. Retrying may consume another processing allowance.
        </p>
      )}
      <details>
        <summary>Preparation details</summary>
        <p>
          {snapshot.provider === 'aws-rekognition'
            ? 'Face search uses AWS Rekognition.'
            : 'No face provider is currently available.'}{' '}
          {snapshot.processingAvailable
            ? 'Background preparation is configured.'
            : 'Background preparation is unavailable.'}
        </p>
        {snapshot.models.length > 0 && (
          <ul>
            {snapshot.models.map((model) => (
              <li key={model.version}>
                Saved model {model.version}: {model.photos} photographs
              </li>
            ))}
          </ul>
        )}
        <p>
          Saved metadata checked at{' '}
          <time dateTime={snapshot.checkedAt}>
            {new Date(snapshot.checkedAt).toLocaleString()}
          </time>
          . This is not a live provider health or accuracy test.
        </p>
      </details>
    </section>
  );
}
