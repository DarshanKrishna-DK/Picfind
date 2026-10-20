import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, HttpError } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import type { InvitedCollection } from '../../../../packages/shared/src/collection-invitation';
import {
  PROOFING_DECISIONS,
  type ProofingDecision,
  type ProofingDecisions,
} from '../../../../packages/shared/src/proofing-decisions';

const labels = {
  favorite: 'Favorite',
  maybe: 'Maybe',
  rejected: 'Reject',
} as const;

function UnavailableDecisions({ count }: { count: number }) {
  return count > 0 ? (
    <p>
      {count} earlier choices refer to photos no longer available. The next
      saved change removes those choices.
    </p>
  ) : null;
}

export function ClientCollectionReview({
  invitationId,
  accountId,
  photos,
}: {
  invitationId: string;
  accountId: string;
  photos: InvitedCollection['photos'];
}) {
  const root = `/proofing-invitations/${invitationId}/decisions`;
  const key = ['client-decisions', invitationId, accountId];
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [filter, setFilter] = useState('all');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api<ProofingDecisions>(root, { signal }),
    gcTime: 0,
    staleTime: 0,
    refetchInterval: busy ? false : 30_000,
    refetchOnWindowFocus: !busy,
  });
  async function save(photoId: string, status: ProofingDecision | null) {
    if (busy || conflict || !query.data || query.error) return;
    setBusy(true);
    setError(null);
    setMessage('');
    const controller = new AbortController();
    pending.current = controller;
    try {
      await client.cancelQueries({ queryKey: key });
      const saved = await api<ProofingDecisions>(root, {
        method: 'PATCH',
        signal: controller.signal,
        body: JSON.stringify({ photoId, status, version: query.data.version }),
      });
      if (!controller.signal.aborted) {
        client.setQueryData(key, saved);
        setMessage('Decision saved.');
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure);
        if (failure instanceof HttpError && failure.status === 409)
          setConflict(true);
        if (
          failure instanceof HttpError &&
          [401, 403, 404].includes(failure.status)
        )
          void query.refetch();
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (pending.current === controller) pending.current = null;
    }
  }
  async function refresh() {
    const result = await query.refetch();
    if (!result.error) {
      setConflict(false);
      setError(null);
      setMessage('Saved decisions refreshed.');
    }
  }
  const saved = new Map(
    query.data?.decisions.map((item) => [item.photoId, item.status]) ?? [],
  );
  const visible = photos.filter(
    (photo) =>
      filter === 'all' ||
      (filter === 'undecided'
        ? !saved.has(photo.id)
        : saved.get(photo.id) === filter),
  );
  return (
    <section aria-label="Your photo decisions">
      <h2>Your photo decisions</h2>
      <p>
        Mark photos for your photographer. These are saved draft choices, not a
        final submission.
      </p>
      <ErrorNote error={query.error ?? error} />
      <p role="status">{message}</p>
      <button
        className="button secondary"
        disabled={busy || query.isFetching}
        onClick={() => void refresh()}
      >
        Refresh saved decisions
      </button>
      {query.isPending ? (
        <Loading />
      ) : (
        !query.error &&
        query.data && (
          <>
            <p>
              {
                photos.filter((photo) => saved.get(photo.id) === 'favorite')
                  .length
              }{' '}
              favorites ·{' '}
              {photos.filter((photo) => saved.get(photo.id) === 'maybe').length}{' '}
              maybe ·{' '}
              {
                photos.filter((photo) => saved.get(photo.id) === 'rejected')
                  .length
              }{' '}
              rejected · {photos.filter((photo) => !saved.has(photo.id)).length}{' '}
              undecided
            </p>
            <UnavailableDecisions count={query.data.unavailableCount} />
            <label>
              Filter photo decisions
              <select
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              >
                <option value="all">All photos</option>
                <option value="undecided">Undecided</option>
                {PROOFING_DECISIONS.map((status) => (
                  <option key={status} value={status}>
                    {labels[status]}
                  </option>
                ))}
              </select>
            </label>
            {visible.length === 0 && (
              <p>No photos match this decision filter.</p>
            )}
            <div className="proofing-photo-options">
              {visible.map((photo) => {
                const url = `/api/proofing-invitations/${invitationId}/photos/${photo.id}`;
                return (
                  <figure key={photo.id} style={{ minWidth: 0, margin: 0 }}>
                    <a href={url} aria-label={`Open ${photo.filename}`}>
                      <img
                        src={url}
                        alt={photo.filename}
                        loading="lazy"
                        style={{
                          width: '100%',
                          aspectRatio: '4 / 3',
                          objectFit: 'contain',
                        }}
                      />
                    </a>
                    <figcaption style={{ overflowWrap: 'anywhere' }}>
                      {photo.filename}
                    </figcaption>
                    <label>
                      Decision for {photo.filename}
                      <select
                        value={saved.get(photo.id) ?? ''}
                        disabled={busy || conflict}
                        onChange={(event) =>
                          void save(
                            photo.id,
                            (event.target.value ||
                              null) as ProofingDecision | null,
                          )
                        }
                      >
                        <option value="">No decision</option>
                        {PROOFING_DECISIONS.map((status) => (
                          <option key={status} value={status}>
                            {labels[status]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </figure>
                );
              })}
            </div>
          </>
        )
      )}
    </section>
  );
}

export function OwnerClientDecisions({
  root,
  invitationId,
  email,
}: {
  root: string;
  invitationId: string;
  email: string;
}) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ['owner-client-decisions', invitationId],
    queryFn: ({ signal }) =>
      api<ProofingDecisions>(`${root}/${invitationId}/decisions`, { signal }),
    enabled: open,
    gcTime: 0,
    staleTime: 0,
  });
  return (
    <section aria-label={`Decisions from ${email}`}>
      <button
        className="button secondary"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        View decisions from {email}
      </button>
      {open && (
        <>
          <button
            className="button secondary"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Refresh client decisions
          </button>
          <ErrorNote error={query.error} />
          {query.isPending ? (
            <Loading />
          ) : (
            !query.error &&
            query.data && (
              <>
                <p>
                  Saved draft choices. Last update:{' '}
                  {query.data.updatedAt
                    ? new Date(query.data.updatedAt).toLocaleString()
                    : 'No choices saved yet'}
                  .
                </p>
                <UnavailableDecisions count={query.data.unavailableCount} />
                {query.data.decisions.length === 0 ? (
                  <p>No available photos have saved choices.</p>
                ) : (
                  <ul>
                    {query.data.decisions.map((item) => (
                      <li key={item.photoId}>
                        {item.filename}: {labels[item.status]}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )
          )}
        </>
      )}
    </section>
  );
}
