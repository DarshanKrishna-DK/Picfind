import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { z } from 'zod';
import { api, HttpError, session } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import {
  clientProposal,
  ownerProposals,
  proposalCreate,
  proposalFields,
  proposalResponseWrite,
  proposalResponseView,
  PROPOSAL_ACTOR,
  PROPOSAL_CONSENT,
  type ProposalResponseView,
} from '../../../../packages/shared/src/studio-proposals';
import {
  serviceExport,
  servicePrice,
  type StudioService,
} from '../../../../packages/shared/src/studio-services';
import './project-proposals.css';

type Owner = z.infer<typeof ownerProposals>;
type Client = z.infer<typeof clientProposal>;
const headers = (id: string) => ({ [PROPOSAL_ACTOR]: id });
const denied = (error: unknown) =>
  error instanceof HttpError && [401, 403, 404].includes(error.status);
const stamp = (value: string) => new Date(value).toLocaleString();
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
function useAction() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [blocked, setBlocked] = useState(false),
    [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function run(operation: (signal: AbortSignal) => Promise<void>) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      await operation(controller.signal);
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure);
        if (denied(failure)) setBlocked(true);
      }
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return { busy, error, blocked, message, setMessage, run };
}
async function readOwner(
  accountId: string,
  projectId: string,
  signal: AbortSignal,
) {
  const [raw, catalog] = await Promise.all([
    api(`/studio/projects/${projectId}/proposals`, {
      signal,
      headers: headers(accountId),
    }),
    api('/studio/services/export?state=active', {
      signal,
      headers: { 'X-PicFind-Service-Actor': accountId },
    }),
  ]);
  const data = ownerProposals.parse(raw),
    services = serviceExport.parse(catalog);
  if (
    data.accountId !== accountId ||
    data.projectId !== projectId ||
    services.accountId !== accountId
  )
    throw new HttpError(
      403,
      'These proposals belong to another account or project.',
    );
  return { data, services: services.services };
}
async function readClient(accountId: string, id: string, signal: AbortSignal) {
  const data = clientProposal.parse(
    await api(`/proposals/${id}`, { signal, headers: headers(accountId) }),
  );
  if (data.accountId !== accountId || data.id !== id)
    throw new HttpError(403, 'This proposal belongs to another account.');
  return data;
}
export function ProjectProposals({ client = false }: { client?: boolean }) {
  const { projectId = '', id = '' } = useParams();
  const account = useQuery({
    queryKey: ['session'],
    queryFn: session,
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  if (account.isPending) return <Loading />;
  if (account.error) return <ErrorNote error={account.error} />;
  const path = client
    ? `/proposals/${id}`
    : `/app/projects/${projectId}/proposals`;
  if (!account.data)
    return (
      <section className="wrap standalone proposal-page">
        <h1>Sign in to view your proposal</h1>
        <p>Use the verified PicFind account the photographer invited.</p>
        <Link
          className="button"
          to={`/sign-in?returnTo=${encodeURIComponent(path)}`}
        >
          Sign in to continue
        </Link>
      </section>
    );
  return client ? (
    <ClientPage
      key={`${account.data.id}:${id}`}
      accountId={account.data.id}
      id={id}
    />
  ) : (
    <OwnerPage
      key={`${account.data.id}:${projectId}`}
      accountId={account.data.id}
      projectId={projectId}
    />
  );
}
function Options({
  options,
  showVersion = false,
}: {
  options: StudioService[];
  showVersion?: boolean;
}) {
  return (
    <div className="proposal-options">
      {options.map((option) => (
        <article className="glass-panel proposal-option" key={option.id}>
          <h3>{option.title}</h3>
          {showVersion && <small>Package revision {option.version}</small>}
          <strong>{servicePrice(option)}</strong>
          {option.durationMinutes !== null && (
            <p>{option.durationMinutes} minutes</p>
          )}
          <p className="proposal-text">{option.description}</p>
          <ul>
            {option.deliverables.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </article>
      ))}
    </div>
  );
}
function Preference({
  response,
  options,
}: {
  response: ProposalResponseView | null;
  options: StudioService[];
}) {
  if (!response) return <p>No client preference recorded.</p>;
  return (
    <div className="proposal-receipt">
      <strong>
        {response.decision === 'decline'
          ? 'Client declined these options'
          : `Preferred: ${options.find((row) => row.id === response.serviceId)?.title ?? 'Unavailable option'}`}
      </strong>
      <p className="proposal-text">{response.note}</p>
      <small>
        Saved {stamp(response.updatedAt)}. Revision {response.version}.
      </small>
    </div>
  );
}
function OwnerPage({
  accountId,
  projectId,
}: {
  accountId: string;
  projectId: string;
}) {
  const query = useQuery({
    queryKey: ['project-proposals', accountId, projectId],
    queryFn: ({ signal }) => readOwner(accountId, projectId, signal),
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  if (query.isPending) return <Loading />;
  if (!query.data || denied(query.error))
    return (
      <section className="glass-panel">
        <h1>Proposals unavailable</h1>
        <ErrorNote error={query.error} />
        <button className="button" onClick={() => void query.refetch()}>
          Retry proposals
        </button>
      </section>
    );
  return (
    <OwnerEditor
      snapshot={query.data}
      readError={query.error}
      fetching={query.isFetching}
      refresh={async () => {
        const result = await query.refetch();
        if (result.error) throw result.error;
        return result.data!;
      }}
    />
  );
}
function OwnerEditor({
  snapshot,
  readError,
  fetching,
  refresh,
}: {
  snapshot: Awaited<ReturnType<typeof readOwner>>;
  readError: unknown;
  fetching: boolean;
  refresh: () => Promise<Awaited<ReturnType<typeof readOwner>>>;
}) {
  const { data, services } = snapshot,
    action = useAction();
  const [baseline, setBaseline] = useState(data),
    [id, setId] = useState(() => crypto.randomUUID()),
    [title, setTitle] = useState('Your photography options'),
    [introduction, setIntroduction] = useState(''),
    [days, setDays] = useState('7'),
    [selected, setSelected] = useState<StudioService[]>([]);
  const changedContext =
    baseline.projectVersion !== data.projectVersion ||
    !same(baseline.client, data.client);
  const changedOptions = selected.some(
    (old) => !services.some((current) => same(current, old)),
  );
  const root = `/studio/projects/${data.projectId}/proposals`;
  const selectionValid = proposalFields.safeParse({
    title,
    introduction,
    options: selected,
  }).success;
  const canIssue =
    data.editable &&
    data.client &&
    !changedContext &&
    !changedOptions &&
    selectionValid &&
    data.proposals.length < data.limit &&
    !readError &&
    !fetching &&
    !action.busy;
  async function issue(event: FormEvent) {
    event.preventDefault();
    if (!canIssue || !baseline.client) return;
    const command = proposalCreate.safeParse({
      title,
      introduction,
      days: Number(days),
      projectVersion: baseline.projectVersion,
      clientId: baseline.client.id,
      clientVersion: baseline.client.version,
      clientEmail: baseline.client.email,
      services: selected.map((row) => ({ id: row.id, version: row.version })),
    });
    if (!command.success) return;
    if (
      !window.confirm(
        `Issue this immutable proposal to ${baseline.client.email}? This records preferences and does not create a booking.`,
      )
    )
      return;
    await action.run(async (signal) => {
      await api(`${root}/${id}`, {
        method: 'PUT',
        signal,
        headers: headers(data.accountId),
        body: JSON.stringify(command.data),
      });
      if (signal.aborted) return;
      // A successful write consumes the stable ID even when the following read fails.
      setId(crypto.randomUUID());
      setSelected([]);
      await refresh();
      if (!signal.aborted)
        action.setMessage(
          'Proposal issued. Share its private link with the named client.',
        );
    });
  }
  function change(row: Owner['proposals'][number], remove: boolean) {
    if (
      !window.confirm(
        remove
          ? 'Remove this proposal and its client preference? This cannot be undone.'
          : 'Withdraw this proposal? The client will no longer be able to change their preference.',
      )
    )
      return;
    void action.run(async (signal) => {
      await api(`${root}/${row.proposal.id}${remove ? '' : '/withdraw'}`, {
        method: remove ? 'DELETE' : 'POST',
        signal,
        headers: headers(data.accountId),
        body: JSON.stringify({
          generation: row.proposal.generation,
          version: row.proposal.version,
        }),
      });
      if (signal.aborted) return;
      await refresh();
      if (!signal.aborted)
        action.setMessage(
          remove
            ? 'Proposal and client preference removed.'
            : 'Proposal withdrawn.',
        );
    });
  }
  if (action.blocked)
    return (
      <section className="glass-panel">
        <h1>Proposals unavailable</h1>
        <ErrorNote error={action.error} />
      </section>
    );
  return (
    <section className="proposal-page">
      <Link to="/app/projects">Back to projects</Link>
      <h1>{data.projectName}: package proposals</h1>
      <p>
        Copy up to three service options into a private client proposal. Issued
        prices and deliverables stay unchanged when your catalog changes.
      </p>
      <p>
        A client preference is for discussion. It does not reserve a date, sign
        a contract or collect payment.
      </p>
      <ErrorNote error={action.error || readError} />
      <p role="status">{action.message}</p>
      <button
        className="button secondary"
        disabled={action.busy || fetching}
        onClick={() =>
          void action.run(async () => {
            await refresh();
          })
        }
      >
        Reload proposals and catalog
      </button>
      <form
        className="glass-panel proposal-form"
        onSubmit={(event) => void issue(event)}
      >
        <h2>Prepare a proposal</h2>
        {!data.client && (
          <p>
            Link a client with an email address from the project editor first.
          </p>
        )}
        {!data.editable && (
          <p>
            This project is archived or being removed. New proposals are
            unavailable.
          </p>
        )}
        {baseline.client && (
          <p>
            Recipient: <strong>{baseline.client.name}</strong> (
            {baseline.client.email}). They must have a verified PicFind account.
          </p>
        )}
        {changedContext && (
          <div role="alert">
            <p>
              The project or recipient changed. Review and load the current
              recipient before issuing.
            </p>
            <button
              type="button"
              disabled={action.busy || fetching || !!readError}
              onClick={() => {
                if (
                  window.confirm(
                    'Use the currently displayed project recipient for this draft?',
                  )
                )
                  setBaseline(data);
              }}
            >
              Load current recipient
            </button>
            <p>Current recipient: {data.client?.email ?? 'No linked client'}</p>
          </div>
        )}
        {changedOptions && (
          <p role="alert">
            A selected package changed or was removed. Deselect and select it
            again to review its latest details.
          </p>
        )}
        <fieldset disabled={action.busy}>
          <legend>Choose up to three packages in one currency</legend>
          <label>
            Proposal title
            <input
              required
              maxLength={100}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            Introduction
            <textarea
              maxLength={1000}
              value={introduction}
              onChange={(event) => setIntroduction(event.target.value)}
            />
          </label>
          <label>
            Valid for days
            <input
              type="number"
              min={1}
              max={30}
              required
              value={days}
              onChange={(event) => setDays(event.target.value)}
            />
          </label>
          <div className="proposal-choices">
            {[
              ...services,
              ...selected.filter(
                (old) => !services.some((row) => row.id === old.id),
              ),
            ].map((row) => (
              <label key={row.id}>
                <input
                  type="checkbox"
                  checked={selected.some((value) => value.id === row.id)}
                  disabled={
                    !selected.some((value) => value.id === row.id) &&
                    selected.length >= 3
                  }
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? [...selected, row]
                        : selected.filter((value) => value.id !== row.id),
                    )
                  }
                />
                {row.title}: {servicePrice(row)}
              </label>
            ))}
          </div>
          {services.length === 0 && (
            <p>
              <Link to="/app/services">Create an active service package</Link>{' '}
              to prepare a proposal.
            </p>
          )}
        </fieldset>
        {selected.length > 0 && (
          <>
            <h3>Draft snapshots</h3>
            <Options options={selected} showVersion />
          </>
        )}
        {!selectionValid && selected.length > 0 && (
          <p role="alert">
            Use a title and one currency, with at most three packages. Combined
            details must fit within 10 KB.
          </p>
        )}
        <button className="button" disabled={!canIssue}>
          Issue proposal
        </button>
      </form>
      <h2>
        Issued proposals ({data.proposals.length} / {data.limit})
      </h2>
      {data.proposals.map((row) => {
        const proposal = row.proposal,
          closed =
            !!proposal.withdrawnAt ||
            Date.parse(proposal.expiresAt) <= Date.now();
        return (
          <article
            className="glass-panel proposal-issued"
            key={`${proposal.id}:${proposal.generation}`}
          >
            <h3>{proposal.title}</h3>
            <p>
              For {proposal.recipientEmail}. Expires {stamp(proposal.expiresAt)}
              .
            </p>
            <p>
              {row.removalPending
                ? 'Removal pending. Retry removal to finish cleanup.'
                : proposal.withdrawnAt
                  ? 'Withdrawn'
                  : closed
                    ? 'Expired'
                    : 'Open for client preferences'}
            </p>
            <p className="proposal-text">{proposal.introduction}</p>
            <Options options={proposal.options} showVersion />
            <Preference response={row.response} options={proposal.options} />
            <label>
              Private proposal link
              <input
                readOnly
                value={
                  new URL(`/proposals/${proposal.id}`, window.location.origin)
                    .href
                }
              />
            </label>
            <div className="proposal-actions">
              {!closed && !row.removalPending && (
                <button
                  className="button secondary"
                  disabled={action.busy || fetching || !!readError}
                  onClick={() => change(row, false)}
                >
                  Withdraw proposal
                </button>
              )}
              {(closed || row.removalPending) && (
                <button
                  className="button secondary"
                  disabled={action.busy || fetching || !!readError}
                  onClick={() => change(row, true)}
                >
                  Remove proposal
                </button>
              )}
            </div>
          </article>
        );
      })}
    </section>
  );
}
function ClientPage({ accountId, id }: { accountId: string; id: string }) {
  const query = useQuery({
    queryKey: ['client-proposal', accountId, id],
    queryFn: ({ signal }) => readClient(accountId, id, signal),
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  if (query.isPending) return <Loading />;
  if (!query.data || denied(query.error))
    return (
      <section className="wrap standalone">
        <h1>Proposal unavailable</h1>
        <ErrorNote error={query.error} />
        <button className="button" onClick={() => void query.refetch()}>
          Retry proposal
        </button>
      </section>
    );
  return (
    <ClientEditor
      key={query.data.generation}
      live={query.data}
      readError={query.error}
      fetching={query.isFetching}
      refresh={async () => {
        const result = await query.refetch();
        if (result.error) throw result.error;
        return result.data!;
      }}
    />
  );
}
function ClientEditor({
  live,
  readError,
  fetching,
  refresh,
}: {
  live: Client;
  readError: unknown;
  fetching: boolean;
  refresh: () => Promise<Client>;
}) {
  const [saved, setSaved] = useState(live),
    [choice, setChoice] = useState(
      live.response?.serviceId ??
        (live.response?.decision === 'decline' ? 'decline' : ''),
    ),
    [note, setNote] = useState(live.response?.note ?? ''),
    [consent, setConsent] = useState(false);
  const action = useAction();
  const stale = !same(saved.response, live.response);
  const accepting = live.accepting && Date.parse(live.expiresAt) > Date.now();
  function adopt(value: Client) {
    setSaved(value);
    setChoice(
      value.response?.serviceId ??
        (value.response?.decision === 'decline' ? 'decline' : ''),
    );
    setNote(value.response?.note ?? '');
    setConsent(false);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!accepting || stale || !consent || !choice || readError || fetching)
      return;
    const input = proposalResponseWrite.safeParse({
      decision: choice === 'decline' ? 'decline' : 'choose',
      serviceId: choice === 'decline' ? null : choice,
      note,
      proposalGeneration: saved.generation,
      generation: saved.response?.generation ?? null,
      version: saved.response?.version ?? 0,
      consent: PROPOSAL_CONSENT,
    });
    if (!input.success) return;
    await action.run(async (signal) => {
      const value = z
        .object({ accountId: z.string(), response: proposalResponseView })
        .strict()
        .parse(
          await api(`/proposals/${saved.id}/response`, {
            method: 'PUT',
            signal,
            headers: headers(saved.accountId),
            body: JSON.stringify(input.data),
          }),
        );
      if (value.accountId !== saved.accountId)
        throw new HttpError(
          403,
          'This reply belongs to another proposal or account.',
        );
      if (signal.aborted) return;
      adopt({ ...saved, response: value.response });
      await refresh();
      if (!signal.aborted)
        action.setMessage(
          'Your preference is saved. Discuss availability and final terms with your photographer.',
        );
    });
  }
  if (action.blocked)
    return (
      <section className="wrap standalone">
        <h1>Proposal unavailable</h1>
        <ErrorNote error={action.error} />
      </section>
    );
  return (
    <section className="wrap standalone proposal-page">
      <h1>{live.fields.title}</h1>
      <p className="proposal-text">{live.fields.introduction}</p>
      <p>
        Available until {stamp(live.expiresAt)}. These are the package details
        your photographer issued.
      </p>
      <Options options={live.fields.options} />
      <Preference response={live.response} options={live.fields.options} />
      <ErrorNote error={action.error || readError} />
      <p role="status">{action.message}</p>
      <button
        className="button secondary"
        disabled={action.busy || fetching}
        onClick={() =>
          void action.run(async () => {
            await refresh();
          })
        }
      >
        Reload proposal
      </button>
      {stale && (
        <p role="alert">
          A newer preference is available. Your draft is preserved. Load the
          latest preference to replace it.
        </p>
      )}
      <button
        className="button secondary"
        disabled={action.busy || fetching || !!readError}
        onClick={() => {
          if (
            window.confirm(
              'Replace your unsaved draft with the latest saved preference?',
            )
          )
            adopt(live);
        }}
      >
        Load latest preference
      </button>
      {!accepting && (
        <p role="alert">
          This proposal is closed. You can read the saved preference but cannot
          change it.
        </p>
      )}
      <form
        className="glass-panel proposal-form"
        onSubmit={(event) => void submit(event)}
      >
        <h2>Your preference</h2>
        <fieldset disabled={action.busy || !accepting}>
          <legend>Choose a package or decline these options</legend>
          <div className="proposal-choices">
            {live.fields.options.map((option) => (
              <label key={option.id}>
                <input
                  type="radio"
                  name="preference"
                  value={option.id}
                  checked={choice === option.id}
                  onChange={() => setChoice(option.id)}
                />
                {option.title}: {servicePrice(option)}
              </label>
            ))}
            <label>
              <input
                type="radio"
                name="preference"
                checked={choice === 'decline'}
                onChange={() => setChoice('decline')}
              />
              Decline these options
            </label>
          </div>
          <label>
            Note for your photographer
            <textarea
              maxLength={1000}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <label className="proposal-consent">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            I agree to share this preference and note with the photographer.
            This does not book a date, sign a contract or make a payment.
          </label>
        </fieldset>
        <button
          className="button"
          disabled={
            action.busy ||
            fetching ||
            !!readError ||
            stale ||
            !accepting ||
            !consent ||
            !choice
          }
        >
          Save preference
        </button>
      </form>
    </section>
  );
}
