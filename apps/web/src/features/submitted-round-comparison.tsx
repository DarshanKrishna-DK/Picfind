import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, saveFile } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import type { CollectionInvitation } from '../../../../packages/shared/src/collection-invitation';
import type { ProofingSubmissionState } from '../../../../packages/shared/src/proofing-submission';
import type { SubmissionComparison } from '../../../../packages/shared/src/submission-comparison';
import {
  filterComparedPhotos,
  type ComparisonFilter,
} from '../../../../packages/shared/src/selection-comparison';
import { exportSelectionFilenames } from '../../../../packages/shared/src/selection-export';

type Choice = { invitationId: string; submissionId: string };
const emptyChoice = { invitationId: '', submissionId: '' };

function RoundPicker({
  label,
  root,
  invitations,
  value,
  onChange,
  disabled,
}: {
  label: string;
  root: string;
  invitations: CollectionInvitation[];
  value: Choice;
  onChange: (choice: Choice) => void;
  disabled: boolean;
}) {
  const query = useQuery({
    queryKey: ['comparison-round-picker', root, value.invitationId],
    queryFn: ({ signal }) =>
      api<ProofingSubmissionState>(`${root}/${value.invitationId}/submission`, {
        signal,
      }),
    enabled: Boolean(value.invitationId),
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const rounds = query.data
    ? [query.data.current, ...query.data.history].filter(
        (item) => item !== null,
      )
    : [];
  return (
    <fieldset disabled={disabled}>
      <legend>{label} submitted round</legend>
      <label>
        {label} invitation
        <select
          value={value.invitationId}
          onChange={(event) =>
            onChange({ invitationId: event.target.value, submissionId: '' })
          }
        >
          <option value="">Choose an invitation</option>
          {invitations.map((item) => (
            <option key={item.id} value={item.id}>
              {item.email} ({new Date(item.createdAt).toLocaleString()})
            </option>
          ))}
        </select>
      </label>
      {value.invitationId && (
        <>
          <ErrorNote error={query.error} />
          {query.isPending ? (
            <Loading />
          ) : (
            !query.error && (
              <label>
                {label} round
                <select
                  disabled={query.isFetching}
                  value={value.submissionId}
                  onChange={(event) =>
                    onChange({ ...value, submissionId: event.target.value })
                  }
                >
                  <option value="">Choose a submitted round</option>
                  {rounds.map((item) => (
                    <option key={item.id} value={item.id}>
                      Round {item.round}, {item.favoriteCount} favorites (
                      {new Date(item.submittedAt).toLocaleString()})
                    </option>
                  ))}
                </select>
              </label>
            )
          )}
          {!query.isPending && !query.error && rounds.length === 0 && (
            <p>No submitted rounds for this invitation yet.</p>
          )}
          <button
            type="button"
            className="button secondary"
            disabled={query.isFetching}
            onClick={() => {
              onChange({ ...value, submissionId: '' });
              void query.refetch();
            }}
          >
            Refresh {label.toLowerCase()} rounds
          </button>
        </>
      )}
    </fieldset>
  );
}

export function SubmittedRoundComparison({
  root,
  invitations,
}: {
  root: string;
  invitations: CollectionInvitation[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Submitted round comparison">
      <button
        className="button secondary"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Compare submitted rounds
      </button>
      {open && (
        <ComparisonForm key={root} root={root} invitations={invitations} />
      )}
    </section>
  );
}

function ComparisonForm({
  root,
  invitations,
}: {
  root: string;
  invitations: CollectionInvitation[];
}) {
  const [first, setFirst] = useState<Choice>(emptyChoice);
  const [second, setSecond] = useState<Choice>(emptyChoice);
  const [filter, setFilter] = useState<ComparisonFilter>('all');
  const [result, setResult] = useState<SubmissionComparison | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const distinct =
    first.submissionId &&
    second.submissionId &&
    first.submissionId !== second.submissionId;
  const visible = result ? filterComparedPhotos(result.photos, filter) : [];
  function choose(side: 'first' | 'second', choice: Choice) {
    if (pending.current) return;
    (side === 'first' ? setFirst : setSecond)(choice);
    setResult(null);
    setError(null);
    setMessage('');
  }
  async function load(exportCsv = false) {
    if (pending.current || !distinct) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    setMessage('');
    setResult(null);
    try {
      const parameters = new URLSearchParams({
        firstInvitationId: first.invitationId,
        firstSubmissionId: first.submissionId,
        secondInvitationId: second.invitationId,
        secondSubmissionId: second.submissionId,
      });
      const latest = await api<SubmissionComparison>(
        `${root.replace(/\/invitations$/, '')}/submission-comparison?${parameters}`,
        { signal: controller.signal },
      );
      controller.signal.throwIfAborted();
      setResult(latest);
      if (exportCsv) {
        const output = exportSelectionFilenames(
          filterComparedPhotos(latest.photos, filter),
          'csv',
        );
        saveFile(
          new Blob([output.content], { type: 'text/csv;charset=utf-8' }),
          `picfind-submitted-comparison-${filter}.csv`,
        );
        setMessage(
          `${output.count} filenames exported from current availability.${output.duplicateNames ? ' Some filenames repeat; use photo IDs to distinguish them.' : ''}`,
        );
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure);
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <div>
      <p>
        Compare two final submitted sets, including earlier rounds. Draft
        choices are excluded. Only the photographer can see this comparison.
      </p>
      <RoundPicker
        label="First"
        root={root}
        invitations={invitations}
        value={first}
        onChange={(value) => choose('first', value)}
        disabled={busy}
      />
      <RoundPicker
        label="Second"
        root={root}
        invitations={invitations}
        value={second}
        onChange={(value) => choose('second', value)}
        disabled={busy}
      />
      {first.submissionId && first.submissionId === second.submissionId && (
        <p>Choose two different submitted rounds.</p>
      )}
      <button
        className="button"
        disabled={busy || !distinct}
        onClick={() => void load()}
      >
        Load round comparison
      </button>
      <ErrorNote error={error} />
      <p role="status">
        {busy
          ? 'Checking submitted rounds and current availability...'
          : message}
      </p>
      {result && (
        <div aria-label="Compared submitted photos">
          <p>
            {result.photos.length} available photos, {result.shared} shared
            favorites.
          </p>
          <p>
            First round: {result.first.unavailableCount} unavailable. Second
            round: {result.second.unavailableCount} unavailable. Counts are per
            round and may refer to the same photos.
          </p>
          <p>
            Availability checked {new Date(result.checkedAt).toLocaleString()}.
          </p>
          <label>
            Submitted comparison photos
            <select
              value={filter}
              disabled={busy}
              onChange={(event) => {
                setFilter(event.target.value as ComparisonFilter);
                setMessage('');
              }}
            >
              <option value="all">All submitted photos</option>
              <option value="shared">Shared favorites</option>
              <option value="first">Only in first round</option>
              <option value="second">Only in second round</option>
            </select>
          </label>
          <ul>
            {visible.map((photo) => (
              <li key={photo.id}>
                {photo.filename}:{' '}
                {photo.selectedBy === 'both'
                  ? 'Both rounds'
                  : photo.selectedBy === 'first'
                    ? 'First round only'
                    : 'Second round only'}
                <span> (Photo ID: {photo.id})</span>
              </li>
            ))}
          </ul>
          {!visible.length && <p>No available photos match this comparison.</p>}
          <button
            className="button secondary"
            disabled={busy || !visible.length}
            onClick={() => void load(true)}
          >
            Export submitted comparison CSV
          </button>
          <p>
            Exports recheck access and photo availability. CSV includes photo
            IDs and filenames only.
          </p>
        </div>
      )}
    </div>
  );
}
