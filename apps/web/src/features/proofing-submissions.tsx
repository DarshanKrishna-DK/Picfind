import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, HttpError } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import { SubmittedRoundExport } from './submitted-round-export';
import { RetouchingChecklist } from './retouching-checklist';
import { proofingCountHint } from '../../../../packages/shared/src/proofing-policy';
import { useSelectionClosed, SelectionWindowNote } from './selection-window';
import type {
  ProofingSubmission,
  ProofingSubmissionState,
} from '../../../../packages/shared/src/proofing-submission';

function Snapshot({
  item,
  ownerRoot,
  disabled,
  refreshAccess,
}: {
  item: ProofingSubmission;
  ownerRoot: string | undefined;
  disabled: boolean;
  refreshAccess: () => Promise<unknown>;
}) {
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
      {ownerRoot && (
        <>
          <SubmittedRoundExport
            root={ownerRoot}
            submissionId={item.id}
            round={item.round}
            disabled={disabled}
            refreshAccess={refreshAccess}
          />
          <RetouchingChecklist
            key={`${ownerRoot}:${item.id}`}
            root={`${ownerRoot}/${item.id}/retouching`}
            disabled={disabled}
          />
        </>
      )}
    </article>
  );
}

export function ProofingSubmissions({
  root,
  accountId,
  owner = false,
  disabled = false,
  decisionVersion,
  onBusy,
  onChanged,
}: {
  root: string;
  accountId: string;
  owner?: boolean;
  disabled?: boolean;
  decisionVersion?: number;
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
          decisionVersion={decisionVersion}
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
  decisionVersion,
  onBusy,
  onChanged,
}: {
  root: string;
  accountId: string;
  owner: boolean;
  disabled: boolean;
  decisionVersion: number | undefined;
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
    queryKey: ['proofing-submission', root, accountId, decisionVersion],
    queryFn: ({ signal }) => api<ProofingSubmissionState>(root, { signal }),
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    retry.current = null;
    setConflict(false);
  }, [decisionVersion]);
  const requirements = query.data?.requirements;
  const closed = useSelectionClosed(requirements?.window);
  const invalidCount = Boolean(
    requirements &&
    (requirements.favoriteCount < requirements.policy.minimum ||
      requirements.favoriteCount > requirements.policy.maximum ||
      requirements.unavailableCount > 0),
  );
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
    if (!owner && (closed || invalidCount)) return;
    if (
      !window.confirm(
        owner
          ? 'Reopen this submitted round? The submitted set stays in private history and the client can edit again.'
          : 'Submit your saved favorites as the final set? Choices will lock until your photographer reopens this round. Only a collection with a minimum of zero accepts an empty set.',
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
            {requirements && (
              <div aria-label="Collection submission requirements">
                <p>
                  Final favorites: {requirements.policy.minimum} to{' '}
                  {requirements.policy.maximum}.
                </p>
                <SelectionWindowNote window={requirements.window} />
                {closed && (
                  <p>
                    Final submissions are closed. The photographer must extend
                    or clear the deadline to accept another submission. Draft
                    choices remain editable after reopening.
                  </p>
                )}
                {!owner && !query.data.current && (
                  <p role="status">
                    {proofingCountHint(
                      requirements.favoriteCount,
                      requirements.policy,
                    )}
                  </p>
                )}
                {!owner &&
                  !query.data.current &&
                  requirements.unavailableCount > 0 && (
                    <p>
                      {requirements.unavailableCount} saved favorites are
                      unavailable. Review and save the current choices before
                      submitting.
                    </p>
                  )}
              </div>
            )}
            {query.data.current && (
              <Snapshot
                item={query.data.current}
                ownerRoot={owner ? root : undefined}
                disabled={busy || disabled || query.isFetching}
                refreshAccess={() => query.refetch()}
              />
            )}
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
                  disabled={
                    busy ||
                    disabled ||
                    conflict ||
                    query.isFetching ||
                    (!owner && (closed || invalidCount))
                  }
                >
                  {owner ? 'Reopen submitted round' : 'Submit final favorites'}
                </button>
              </form>
            )}
            {query.data.history.length > 0 && (
              <div>
                <h3>Earlier submitted rounds</h3>
                {query.data.history.map((item) => (
                  <Snapshot
                    key={item.id}
                    item={item}
                    ownerRoot={owner ? root : undefined}
                    disabled={busy || disabled || query.isFetching}
                    refreshAccess={() => query.refetch()}
                  />
                ))}
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}
