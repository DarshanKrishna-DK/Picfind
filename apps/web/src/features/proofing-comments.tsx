import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, HttpError, session } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import {
  PROOFING_COMMENT_LENGTH,
  type ProofingDiscussion,
} from '../../../../packages/shared/src/proofing-comments';

export function ProofingComments({
  root,
  title,
}: {
  root: string;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const account = useQuery({ queryKey: ['session'], queryFn: session });
  return (
    <section aria-label={title}>
      <button
        className="button secondary"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {title}
      </button>
      {open &&
        (account.data ? (
          <Discussion
            key={`${root}:${account.data.id}`}
            root={root}
            accountId={account.data.id}
          />
        ) : (
          <ErrorNote
            error={
              account.error ??
              new Error('Sign in to read this private discussion.')
            }
          />
        ))}
    </section>
  );
}

function Discussion({ root, accountId }: { root: string; accountId: string }) {
  const [photoId, setPhotoId] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const operation = useRef(false);
  const pending = useRef<AbortController | null>(null);
  const attempt = useRef<{ id: string; photoId: string; text: string } | null>(
    null,
  );
  useEffect(() => () => pending.current?.abort(), []);
  const query = useQuery({
    queryKey: ['proofing-discussion', root, accountId],
    queryFn: ({ signal }) => api<ProofingDiscussion>(root, { signal }),
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const photo =
    query.data?.photos.find((row) => row.id === photoId) ??
    (photoId ? undefined : query.data?.photos[0]);
  const denied =
    error instanceof HttpError && [401, 403, 404].includes(error.status);
  async function mutate(
    work: (signal: AbortSignal) => Promise<unknown>,
    success: string,
    clearDraft = false,
  ) {
    if (operation.current || query.isFetching) return;
    operation.current = true;
    setBusy(true);
    setError(null);
    setMessage('');
    const controller = new AbortController();
    pending.current = controller;
    try {
      await work(controller.signal);
      if (controller.signal.aborted) return;
      if (clearDraft) {
        setDraft('');
        attempt.current = null;
      }
      setMessage(success);
      await query.refetch();
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure);
        if (
          failure instanceof HttpError &&
          [401, 403, 404].includes(failure.status)
        ) {
          setDraft('');
          attempt.current = null;
          await query.refetch();
        }
      }
    } finally {
      operation.current = false;
      if (!controller.signal.aborted) setBusy(false);
      if (pending.current === controller) pending.current = null;
    }
  }
  function send(event: FormEvent) {
    event.preventDefault();
    if (
      !photo ||
      !draft.trim() ||
      !query.data?.canPost ||
      query.error ||
      denied
    )
      return;
    const text = draft.trim();
    if (
      !attempt.current ||
      attempt.current.photoId !== photo.id ||
      attempt.current.text !== text
    )
      attempt.current = { id: crypto.randomUUID(), photoId: photo.id, text };
    const body = JSON.stringify(attempt.current);
    void mutate(
      (signal) => api(root, { method: 'POST', body, signal }),
      'Message saved.',
      true,
    );
  }
  async function refresh() {
    if (operation.current || query.isFetching) return;
    operation.current = true;
    setBusy(true);
    try {
      const result = await query.refetch();
      if (!result.error) {
        setError(null);
        setMessage('Discussion refreshed.');
      }
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <p>
        Private discussion with this invited client and the photographer.
        Messages are saved here; no email is sent.
      </p>
      <ErrorNote error={query.error ?? error} />
      <p role="status">{message}</p>
      <button
        className="button secondary"
        disabled={busy || query.isFetching}
        onClick={() => void refresh()}
      >
        Refresh discussion
      </button>
      {query.isPending ? (
        <Loading />
      ) : (
        !query.error &&
        !denied &&
        query.data && (
          <>
            <label>
              Discussion photo
              <select
                value={photo?.id ?? ''}
                disabled={busy || query.isFetching}
                onChange={(event) => {
                  if (
                    draft.trim() &&
                    !window.confirm(
                      'Discard this unsent message and switch photos?',
                    )
                  )
                    return;
                  setPhotoId(event.target.value);
                  setDraft('');
                  attempt.current = null;
                  setMessage('');
                }}
              >
                <option value="" disabled>
                  Choose an available photo
                </option>
                {query.data.photos.map((row, index) => (
                  <option key={row.id} value={row.id}>
                    {index + 1}. {row.filename}
                  </option>
                ))}
              </select>
            </label>
            {query.data.unavailableCount > 0 && (
              <p>
                {query.data.unavailableCount} earlier messages or removal
                markers are currently unavailable.
              </p>
            )}
            {!photo ? (
              <p>
                No selected photo is currently available. Choose another photo
                if one is listed.
              </p>
            ) : (
              <>
                <ol aria-label="Photo messages" className="selection-list">
                  {query.data.comments
                    .filter((row) => row.photoId === photo.id)
                    .map((row) => (
                      <li key={row.id} className="selection-card">
                        <p>
                          <strong>
                            {row.author === 'client'
                              ? 'Client'
                              : 'Photographer'}
                          </strong>{' '}
                          ·{' '}
                          <time dateTime={row.createdAt}>
                            {new Date(row.createdAt).toLocaleString()}
                          </time>
                        </p>
                        <p
                          style={{
                            whiteSpace: 'pre-wrap',
                            overflowWrap: 'anywhere',
                          }}
                        >
                          {row.text ?? 'Message removed.'}
                        </p>
                        {row.canRemove && (
                          <button
                            className="button secondary"
                            disabled={busy || query.isFetching}
                            onClick={() => {
                              if (
                                window.confirm(
                                  'Remove this message text? A removed-message marker will remain.',
                                )
                              )
                                void mutate(
                                  (signal) =>
                                    api(`${root}/${row.id}`, {
                                      method: 'DELETE',
                                      signal,
                                    }),
                                  'Message removed.',
                                );
                            }}
                          >
                            Remove message
                          </button>
                        )}
                      </li>
                    ))}
                </ol>
                {query.data.comments.every(
                  (row) => row.photoId !== photo.id,
                ) && <p>No messages for this photo yet.</p>}
                {query.data.canPost ? (
                  <form className="stack" onSubmit={send}>
                    <label>
                      Message to client or photographer
                      <textarea
                        value={draft}
                        maxLength={PROOFING_COMMENT_LENGTH}
                        required
                        disabled={busy || query.isFetching}
                        onChange={(event) => {
                          setPhotoId(photo.id);
                          setDraft(event.target.value);
                        }}
                      />
                    </label>
                    <p>
                      {draft.length}/{PROOFING_COMMENT_LENGTH} characters.{' '}
                      {query.data.remaining} message slots remain for this
                      invitation.
                    </p>
                    <button
                      className="button"
                      disabled={busy || query.isFetching || !draft.trim()}
                    >
                      Save message
                    </button>
                  </form>
                ) : (
                  <p>
                    New messages are closed because this invitation is inactive
                    or its message limit has been reached.
                  </p>
                )}
              </>
            )}
          </>
        )
      )}
    </div>
  );
}
