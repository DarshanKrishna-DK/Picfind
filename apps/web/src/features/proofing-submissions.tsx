import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, HttpError } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import type {
  ProofingSubmission,
  ProofingSubmissionState,
} from '../../../../packages/shared/src/proofing-submission';

function Snapshot({ item }: { item: ProofingSubmission }) {
  return (
    <article aria-label={`Submitted round ${item.round}`}>
      <h4>
        Round {item.round}: {item.favoriteCount} submitted favorites
      </h4>
      <p>Submitted {new Date(item.submittedAt).toLocaleString()}.</p>
      {item.note && <p>Client note: {item.note}</p>}
      {item.unavailableCount > 0 && (
        <p>
          {item.unavailableCount} submitted photos are no longer available in
          this collection.
        </p>
      )}
      <ul>
        {item.photos.map((photo) => (
          <li key={photo.photoId}>{photo.filename}</li>
        ))}
      </ul>
    </article>
  );
}

export function ProofingSubmissions({
  root,
  accountId,
  owner = false,
  disabled = false,
  onBusy,
  onChanged,
}: {
  root: string;
  accountId: string;
  owner?: boolean;
  disabled?: boolean;
  onBusy?: (value: boolean) => void;
  onChanged: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section
      aria-label={owner ? 'Client submission history' : 'Your final submission'}
    >
      <button
        className="button secondary"
        disabled={disabled}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {owner ? 'View submitted rounds' : 'Review final submission'}
      </button>
      {open && (
        <SubmissionForm
          key={`${root}:${accountId}`}
          root={root}
          accountId={accountId}
          owner={owner}
          disabled={disabled}
          onBusy={onBusy}
          onChanged={onChanged}
        />
      )}
    </section>
  );
}

function SubmissionForm({
  root,
  accountId,
  owner,
  disabled,
  onBusy,
  onChanged,
}: {
  root: string;
  accountId: string;
  owner: boolean;
  disabled: boolean;
  onBusy: ((value: boolean) => void) | undefined;
  onChanged: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  const operation = useRef(false);
  const retry = useRef<{
    id: string;
    decisionVersion: number;
    collectionVersion: number;
    note: string;
  } | null>(null);
  const query = useQuery({
    queryKey: ['proofing-submission', root, accountId],
    queryFn: ({ signal }) => api<ProofingSubmissionState>(root, { signal }),
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  useEffect(
    () => () => {
      pending.current?.abort();
      onBusy?.(false);
    },
    [onBusy],
  );
  async function refresh() {
    if (operation.current || disabled || query.isFetching) return;
    operation.current = true;
    setBusy(true);
    onBusy?.(true);
    try {
      const result = await query.refetch();
      if (!result.error) {
        retry.current = null;
        setConflict(false);
        setError(null);
        await onChanged();
      }
    } finally {
      operation.current = false;
      setBusy(false);
      onBusy?.(false);
    }
  }
  async function save() {
    const state = query.data;
    if (
      operation.current ||
      disabled ||
      busy ||
      conflict ||
      query.isFetching ||
      query.error ||
      !state
    )
      return;
    if (owner ? !state.canReopen : Boolean(state.current)) return;
    if (
      !window.confirm(
        owner
          ? 'Reopen this submitted round? The submitted set stays in private history and the client can edit again.'
          : 'Submit your saved favorites as the final set, including zero if no favorites are saved? Choices will lock until your photographer reopens this round.',
      )
    )
      return;
    operation.current = true;
    setBusy(true);
    onBusy?.(true);
    setError(null);
    setMessage('');
    const controller = new AbortController();
    pending.current = controller;
    try {
      if (!owner)
        retry.current ??= {
          id: crypto.randomUUID(),
          decisionVersion: state.decisionVersion,
          collectionVersion: state.collectionVersion,
          note: text.trim(),
        };
      await api(root, {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify(
          owner
            ? { submissionId: state.current!.id, reason: text.trim() }
            : retry.current,
        ),
      });
      if (!controller.signal.aborted) {
        retry.current = null;
        setText('');
        setMessage(
          owner
            ? 'Round reopened. The earlier submission is preserved.'
            : 'Final favorites submitted. Choices are locked.',
        );
        await Promise.all([query.refetch(), onChanged()]);
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
          await query.refetch();
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      onBusy?.(false);
      operation.current = false;
      if (pending.current === controller) pending.current = null;
    }
  }
  const denied =
    error instanceof HttpError && [401, 403, 404].includes(error.status);
  return (
    <div>
      <ErrorNote error={query.error ?? error} />
      <p role="status">{message}</p>
      <button
        className="button secondary"
        disabled={busy || disabled || query.isFetching}
        onClick={() => void refresh()}
      >
        Refresh submission
      </button>
      {query.isPending ? (
        <Loading />
      ) : (
        !query.error &&
        !denied &&
        query.data && (
          <>
            <p>
              {query.data.current
                ? 'This round is submitted and locked.'
                : `Round ${query.data.round} is open for saved draft choices.`}
            </p>
            {query.data.reopenReason && (
              <p>Photographer reopening reason: {query.data.reopenReason}</p>
            )}
            {query.data.current && <Snapshot item={query.data.current} />}
            {(owner ? query.data.canReopen : !query.data.current) && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}
              >
                <p>
                  {owner
                    ? 'Explain the changes requested for the next round.'
                    : 'Only saved favorites are submitted. Maybe, rejected and undecided photos are excluded. Refresh this panel after changing saved decisions.'}
                </p>
                <label>
                  {owner ? 'Reason to reopen' : 'Final submission note'}
                  <textarea
                    maxLength={200}
                    required={owner}
                    value={text}
                    disabled={busy || disabled || conflict}
                    onChange={(event) => {
                      setText(event.target.value);
                      retry.current = null;
                    }}
                  />
                </label>
                <button
                  className="button"
                  disabled={busy || disabled || conflict || query.isFetching}
                >
                  {owner ? 'Reopen submitted round' : 'Submit final favorites'}
                </button>
              </form>
            )}
            {query.data.history.length > 0 && (
              <div>
                <h3>Earlier submitted rounds</h3>
                {query.data.history.map((item) => (
                  <Snapshot key={item.id} item={item} />
                ))}
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}
