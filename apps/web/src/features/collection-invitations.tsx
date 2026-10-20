import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, session } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import { ProofingComments } from './proofing-comments';
import { SubmittedRoundComparison } from './submitted-round-comparison';
import {
  ClientCollectionReview,
  OwnerClientDecisions,
} from './proofing-decisions';
import type {
  CollectionInvitation,
  InvitedCollection,
} from '../../../../packages/shared/src/collection-invitation';

export function CollectionInvitations({
  eventId,
  collectionId,
  title,
}: {
  eventId: string;
  collectionId: string;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        className="button secondary"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Client invitations for {title}
      </button>
      {open && (
        <InvitationManager eventId={eventId} collectionId={collectionId} />
      )}
    </div>
  );
}

function InvitationManager({
  eventId,
  collectionId,
}: {
  eventId: string;
  collectionId: string;
}) {
  const root = `/events/${eventId}/proofing-collections/${collectionId}/invitations`;
  const query = useQuery({
    queryKey: ['collection-invitations', eventId, collectionId],
    queryFn: ({ signal }) =>
      api<{ invitations: CollectionInvitation[] }>(root, { signal }),
    gcTime: 0,
  });
  const [email, setEmail] = useState('');
  const [days, setDays] = useState('7');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      await api(root, {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), days: Number(days) }),
      });
      setEmail('');
      setMessage(
        'Invitation created. Copy its link and send it to your client.',
      );
      await query.refetch();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function revoke(invitation: CollectionInvitation) {
    if (
      busy ||
      !window.confirm(`Revoke collection access for ${invitation.email}?`)
    )
      return;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      await api(`${root}/${invitation.id}`, { method: 'DELETE' });
      setMessage(
        'Invitation revoked. Future collection and photo requests are denied.',
      );
      await query.refetch();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="source-panel" aria-label="Collection invitations">
      <p>
        Invite a verified PicFind account to view this collection. Saved changes
        to the collection also change what the client can see. No organizer
        permissions are granted.
      </p>
      <form onSubmit={(event) => void create(event)} className="stack">
        <label>
          Client account email
          <input
            type="email"
            required
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={busy}
          />
        </label>
        <label>
          Access duration in days
          <input
            type="number"
            min={1}
            max={30}
            required
            value={days}
            onChange={(event) => setDays(event.target.value)}
            disabled={busy}
          />
        </label>
        <p>
          Access ends sooner if the event expires. Creating an invitation does
          not send email.
        </p>
        <button className="button" disabled={busy}>
          Create invitation
        </button>
      </form>
      <ErrorNote error={error ?? query.error} />
      <p role="status">{message}</p>
      <button
        className="button secondary"
        disabled={busy || query.isFetching}
        onClick={() => void query.refetch()}
      >
        Refresh invitations
      </button>
      {query.isPending ? (
        <Loading />
      ) : (
        !query.error &&
        query.data && (
          <>
            <SubmittedRoundComparison
              root={root}
              invitations={query.data.invitations}
            />
            <ul className="selection-list">
              {query.data.invitations.map((invitation) => {
                const url = `${window.location.origin}/proofing/${invitation.id}`;
                const expired = !(
                  Date.parse(invitation.expiresAt) > Date.now()
                );
                return (
                  <li className="selection-card" key={invitation.id}>
                    <strong>{invitation.email}</strong>
                    <p>
                      {invitation.revokedAt
                        ? 'Revoked'
                        : expired
                          ? 'Expired'
                          : 'Active'}{' '}
                      · Expires{' '}
                      {new Date(invitation.expiresAt).toLocaleString()}
                    </p>
                    <OwnerClientDecisions
                      root={root}
                      invitationId={invitation.id}
                      email={invitation.email}
                    />
                    <ProofingComments
                      root={`${root}/${invitation.id}/comments`}
                      title={`Photo discussion with ${invitation.email}`}
                    />
                    {!invitation.revokedAt && !expired && (
                      <>
                        <label>
                          Invitation link for {invitation.email}
                          <input
                            readOnly
                            value={url}
                            onFocus={(event) => event.target.select()}
                          />
                        </label>
                        <button
                          className="button secondary"
                          onClick={() => {
                            if (!navigator.clipboard) {
                              setMessage(
                                'Select the invitation link to copy it manually.',
                              );
                              return;
                            }
                            void navigator.clipboard
                              .writeText(url)
                              .then(() => setMessage('Invitation link copied.'))
                              .catch(() =>
                                setMessage(
                                  'Select the invitation link to copy it manually.',
                                ),
                              );
                          }}
                        >
                          Copy invitation link
                        </button>
                        <button
                          className="button secondary"
                          disabled={busy}
                          onClick={() => void revoke(invitation)}
                        >
                          Revoke access for {invitation.email}
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )
      )}
    </section>
  );
}

export function InvitedCollectionPage() {
  const { invitationId } = useParams();
  const account = useQuery({ queryKey: ['session'], queryFn: session });
  const query = useQuery({
    queryKey: ['invited-collection', invitationId, account.data?.id],
    queryFn: ({ signal }) =>
      api<InvitedCollection>(`/proofing-invitations/${invitationId}`, {
        signal,
      }),
    enabled: Boolean(account.data),
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });
  return (
    <section className="wrap standalone" aria-label="Invited collection">
      {account.isPending ? (
        <Loading />
      ) : account.error ? (
        <ErrorNote error={account.error} />
      ) : !account.data ? (
        <>
          <h1>Your collection invitation</h1>
          <p>Sign in with the PicFind account your photographer invited.</p>
          <Link
            className="button"
            to={`/sign-in?returnTo=${encodeURIComponent(`/proofing/${invitationId}`)}`}
          >
            Sign in to view collection
          </Link>
        </>
      ) : query.isPending ? (
        <Loading />
      ) : query.error ? (
        <>
          <h1>This collection is unavailable.</h1>
          <ErrorNote error={query.error} />
          <p>
            Use the invited account. The photographer may have revoked access,
            or the invitation or event may have expired.
          </p>
          <button
            className="button"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Retry collection access
          </button>
        </>
      ) : (
        query.data && (
          <>
            <h1>{query.data.title}</h1>
            <p>
              {query.data.eventTitle} · {query.data.photos.length} available
              photos
            </p>
            <p>
              Access expires {new Date(query.data.expiresAt).toLocaleString()}.
              This view follows the photographer’s saved collection.
            </p>
            <button
              className="button secondary"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              Refresh collection
            </button>
            {query.data.photos.length === 0 && (
              <p>No photos are currently available in this collection.</p>
            )}
            <ClientCollectionReview
              key={`${invitationId}:${account.data.id}`}
              invitationId={invitationId!}
              accountId={account.data.id}
              photos={query.data.photos}
            />
            <ProofingComments
              root={`/proofing-invitations/${invitationId}/comments`}
              title="Photo discussion with your photographer"
            />
          </>
        )
      )}
    </section>
  );
}
