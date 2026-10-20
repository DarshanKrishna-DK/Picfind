import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, HttpError, session } from '../api';
import { ErrorNote, Loading, PageTitle } from '../components/ui';
import { ENQUIRY_ACTOR } from '../../../../packages/shared/src/studio-enquiries';
import {
  handoffCommand,
  handoffPreview,
  type HandoffPreview,
} from '../../../../packages/shared/src/enquiry-handoff';
import type { ClientFields } from '../../../../packages/shared/src/studio-clients';
import './studio-enquiries.css';
import './enquiry-handoff.css';

const denied = (error: unknown) =>
  error instanceof HttpError && [401, 403, 404].includes(error.status);
export function EnquiryProjectHandoff() {
  const { id = '' } = useParams();
  const account = useQuery({
    queryKey: ['session'],
    queryFn: session,
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  if (account.isPending) return <Loading />;
  if (account.error || !account.data)
    return (
      <ErrorNote
        error={account.error ?? new Error('Sign in to manage this handoff.')}
      />
    );
  return (
    <HandoffEditor
      key={`${account.data.id}:${id}`}
      accountId={account.data.id}
      id={id}
    />
  );
}
function draftOf(value: HandoffPreview) {
  const enquiry = value.enquiry;
  return {
    client: {
      name: enquiry.name,
      email: enquiry.email,
      phone: enquiry.phone,
      company: '',
    } as ClientFields,
    clientId:
      value.clients.find(
        (client) => client.email === enquiry.email.toLowerCase(),
      )?.id ?? 'new',
    projectName: `${enquiry.sessionType}: ${enquiry.name}`.slice(0, 100),
    projectSummary: '',
  };
}
function HandoffEditor({ accountId, id }: { accountId: string; id: string }) {
  const cache = useQueryClient(),
    key = ['enquiry-handoff', accountId, id];
  const [baseline, setBaseline] = useState<HandoffPreview | null>(null);
  const [draft, setDraft] = useState<ReturnType<typeof draftOf> | null>(null);
  const [identities, setIdentities] = useState(() => ({
    operationId: crypto.randomUUID(),
    clientId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
  }));
  const [confirmMissing, setConfirmMissing] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null),
    [message, setMessage] = useState(''),
    [blocked, setBlocked] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const headers = { [ENQUIRY_ACTOR]: accountId },
    endpoint = `/studio/enquiries/${id}/handoff`;
  async function read(signal: AbortSignal) {
    const value = handoffPreview.parse(
      await api(endpoint, { headers, signal }),
    );
    if (value.accountId !== accountId || value.enquiry.id !== id)
      throw new HttpError(403, 'This handoff belongs to another account.');
    return value;
  }
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => read(signal),
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  useEffect(() => {
    if (!baseline && query.data && !query.error) {
      setBaseline(query.data);
      setDraft(draftOf(query.data));
    }
  }, [baseline, query.data, query.error]);
  function adopt(value: HandoffPreview) {
    cache.setQueryData(key, value);
    setBaseline(value);
    setDraft(draftOf(value));
    setConfirmMissing(false);
    setBlocked(false);
    setIdentities({
      operationId: crypto.randomUUID(),
      clientId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
    });
  }
  const stale =
    blocked ||
    !!query.error ||
    !!(
      baseline &&
      query.data &&
      (baseline.sourceToken !== query.data.sourceToken ||
        baseline.recoveryToken !== query.data.recoveryToken)
    );
  const dirty =
    baseline &&
    !baseline.handoff &&
    JSON.stringify(draft) !== JSON.stringify(draftOf(baseline));
  async function run(
    work: (signal: AbortSignal) => Promise<HandoffPreview>,
    success: string,
    loading = false,
  ) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      const result = await work(controller.signal);
      if (!controller.signal.aborted) {
        adopt(result);
        setMessage(success);
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure);
        if (loading || (failure instanceof HttpError && failure.status === 409))
          setBlocked(true);
      }
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  function reload() {
    if (
      dirty &&
      !window.confirm(
        'Discard these unsaved handoff details and load the latest preview?',
      )
    )
      return;
    void run(read, 'Latest handoff preview loaded.', true);
  }
  function send(body: unknown, success: string) {
    if (stale || query.isFetching || busy) return;
    const parsed = handoffCommand.safeParse(body);
    if (!parsed.success) {
      setError(
        new Error(
          'Review the contact and project fields. Use a valid email and bounded single-line contact details.',
        ),
      );
      return;
    }
    void run(async (signal) => {
      const value = handoffPreview.parse(
        await api(endpoint, {
          method: 'PUT',
          signal,
          headers,
          body: JSON.stringify(parsed.data),
        }),
      );
      if (value.accountId !== accountId || value.enquiry.id !== id)
        throw new HttpError(403, 'This handoff belongs to another account.');
      void cache.invalidateQueries({
        queryKey: ['studio-enquiries', accountId],
      });
      void cache.invalidateQueries({ queryKey: ['studio-clients', accountId] });
      void cache.invalidateQueries({
        queryKey: ['studio-projects', accountId],
      });
      return value;
    }, success);
  }
  function start() {
    if (!baseline || !draft) return;
    const existing = baseline.clients.find(
      (client) => client.id === draft.clientId,
    );
    if (draft.clientId !== 'new' && !existing) return;
    if (
      !window.confirm(
        'Create this private client/project handoff? The project starts at inquiry. This does not confirm a booking or payment.',
      )
    )
      return;
    send(
      {
        action: 'start',
        operationId: identities.operationId,
        version: baseline.enquiry.version,
        sourceToken: baseline.sourceToken,
        client: existing
          ? { mode: 'existing', snapshot: existing }
          : { mode: 'new', id: identities.clientId, fields: draft.client },
        project: {
          id: identities.projectId,
          name: draft.projectName,
          summary: draft.projectSummary,
        },
      },
      'Handoff completed. Your private project is ready.',
    );
  }
  if (denied(error) || denied(query.error))
    return (
      <section>
        <h1>Enquiry handoff unavailable</h1>
        <ErrorNote error={error || query.error} />
      </section>
    );
  const missingTargets = baseline?.targets
    ? Object.values(baseline.targets).filter((target) => target.mayCreate)
    : [];
  const cannotResume =
    baseline?.targets &&
    Object.values(baseline.targets).some(
      (target) =>
        target.status === 'changed' ||
        (target.status === 'missing' && !target.mayCreate),
    );
  const selectedClient = baseline?.clients.find(
    (client) => client.id === draft?.clientId,
  );
  return (
    <section className="handoff-page">
      <PageTitle title="Enquiry to project" eyebrow="Private studio handoff" />
      <Link to="/app/enquiries">Back to enquiries</Link>
      <p>
        Review the client and project details before creating work. Contact
        details submitted through the enquiry form are unverified.
      </p>
      <ErrorNote error={error || query.error} />
      <p role="status">{message}</p>
      <button
        className="button secondary"
        disabled={busy || query.isFetching}
        onClick={reload}
      >
        Load latest handoff
      </button>
      {query.isPending && <Loading />}
      {baseline && draft && (
        <>
          <section className="glass-panel handoff-source">
            <h2>Enquiry from {baseline.enquiry.name}</h2>
            <p>
              {baseline.enquiry.email}{' '}
              {baseline.enquiry.phone && ` · ${baseline.enquiry.phone}`}
            </p>
            <p>
              {baseline.enquiry.sessionType}{' '}
              {baseline.enquiry.date && ` · ${baseline.enquiry.date}`}
            </p>
            <p className="enquiry-text">{baseline.enquiry.message}</p>
          </section>
          {stale && (
            <p role="alert">
              The source or handoff changed, or a refresh failed. Your draft is
              retained. Load the latest preview before continuing.
            </p>
          )}
          {!baseline.handoff ? (
            <section className="glass-panel handoff-draft">
              <h2>Review new work</h2>
              <fieldset className="enquiry-form" disabled={busy}>
                <label>
                  Client record
                  <select
                    value={draft.clientId}
                    onChange={(event) =>
                      setDraft({ ...draft, clientId: event.target.value })
                    }
                  >
                    <option value="new">Create a new client</option>
                    {baseline.clients.map((client) => (
                      <option key={client.id} value={client.id}>
                        {client.name}
                        {client.email ? ` (${client.email})` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                {baseline.totalClients > baseline.clients.length && (
                  <p>
                    Showing the first {baseline.clients.length} clients. Manage
                    your client directory before adding more contacts.
                  </p>
                )}
                {draft.clientId === 'new' ? (
                  (
                    [
                      ['name', 'Client name', 100],
                      ['email', 'Client email', 254],
                      ['phone', 'Client phone', 40],
                      ['company', 'Client company', 100],
                    ] as const
                  ).map(([field, title, max]) => (
                    <label key={field}>
                      {title}
                      <input
                        value={draft.client[field]}
                        maxLength={max}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            client: {
                              ...draft.client,
                              [field]: event.target.value,
                            },
                          })
                        }
                      />
                    </label>
                  ))
                ) : (
                  <div>
                    <p>
                      The selected client record will be reused without changing
                      its contact details.
                    </p>
                    <dl>
                      <dt>Name</dt>
                      <dd>{selectedClient?.name}</dd>
                      <dt>Email</dt>
                      <dd>{selectedClient?.email || 'Not provided'}</dd>
                      <dt>Phone</dt>
                      <dd>{selectedClient?.phone || 'Not provided'}</dd>
                      <dt>Company</dt>
                      <dd>{selectedClient?.company || 'Not provided'}</dd>
                    </dl>
                  </div>
                )}
                <label>
                  Project name
                  <input
                    value={draft.projectName}
                    maxLength={100}
                    onChange={(event) =>
                      setDraft({ ...draft, projectName: event.target.value })
                    }
                  />
                </label>
                <label>
                  Project summary
                  <textarea
                    value={draft.projectSummary}
                    maxLength={1000}
                    onChange={(event) =>
                      setDraft({ ...draft, projectSummary: event.target.value })
                    }
                  />
                </label>
                <p>
                  The project starts at inquiry with no linked event galleries.
                  This does not confirm a booking, payment or contract.
                </p>
                <button
                  className="button"
                  disabled={stale || query.isFetching}
                  onClick={start}
                >
                  Create client/project handoff
                </button>
              </fieldset>
            </section>
          ) : (
            <section className="glass-panel handoff-recovery">
              <h2>
                {baseline.handoff.status === 'pending'
                  ? 'Handoff needs recovery'
                  : baseline.handoff.status === 'completed'
                    ? 'Handoff completed'
                    : 'Handoff abandoned'}
              </h2>
              <div className="handoff-targets">
                {baseline.targets &&
                  Object.entries(baseline.targets).map(([kind, target]) => (
                    <article key={kind}>
                      <h3>{kind === 'client' ? 'Client' : 'Project'}</h3>
                      <p>{target.name}</p>
                      {baseline.handoff?.status === 'pending' &&
                        (kind === 'client' ? (
                          <dl>
                            <dt>Planned email</dt>
                            <dd>
                              {baseline.handoff.client.email || 'Not provided'}
                            </dd>
                            <dt>Planned phone</dt>
                            <dd>
                              {baseline.handoff.client.phone || 'Not provided'}
                            </dd>
                            <dt>Planned company</dt>
                            <dd>
                              {baseline.handoff.client.company ||
                                'Not provided'}
                            </dd>
                          </dl>
                        ) : (
                          <p>
                            {baseline.handoff.project.summary ||
                              'No project summary entered.'}
                          </p>
                        ))}
                      <p>
                        {target.status === 'matching'
                          ? 'Record is available.'
                          : target.status === 'missing'
                            ? 'Record is missing.'
                            : 'Record changed or is unavailable.'}
                      </p>
                      {target.status === 'matching' && (
                        <Link
                          to={
                            kind === 'client' ? '/app/clients' : '/app/projects'
                          }
                        >
                          {kind === 'client'
                            ? 'View client directory'
                            : 'View studio projects'}
                        </Link>
                      )}
                    </article>
                  ))}
              </div>
              {baseline.handoff.status === 'pending' ? (
                <>
                  <p>
                    Existing records are retained. Resume only after reviewing
                    their current state. Abandonment leaves any created client
                    or project in your studio.
                  </p>
                  {!!missingTargets.length && (
                    <label className="enquiry-checkbox">
                      <input
                        type="checkbox"
                        checked={confirmMissing}
                        disabled={busy}
                        onChange={(event) =>
                          setConfirmMissing(event.target.checked)
                        }
                      />
                      Create the missing planned records shown above. A
                      previously removed record may be recreated.
                    </label>
                  )}
                  {cannotResume && (
                    <p role="alert">
                      A destination changed or a pre-existing client was
                      removed. Abandon this handoff and reconcile the records
                      manually.
                    </p>
                  )}
                  <div className="enquiry-controls">
                    <button
                      className="button"
                      disabled={
                        busy ||
                        stale ||
                        query.isFetching ||
                        !!cannotResume ||
                        (!!missingTargets.length && !confirmMissing)
                      }
                      onClick={() =>
                        send(
                          {
                            action: 'resume',
                            operationId: baseline.handoff!.operationId,
                            recoveryToken: baseline.recoveryToken,
                            createMissing: missingTargets.map(
                              (target) => target.id,
                            ),
                          },
                          'Handoff completed. Your private project is ready.',
                        )
                      }
                    >
                      Resume handoff
                    </button>
                    <button
                      className="button secondary"
                      disabled={busy || stale || query.isFetching}
                      onClick={() => {
                        if (
                          window.confirm(
                            'Abandon this handoff? Any client or project already created will remain in your studio.',
                          )
                        )
                          send(
                            {
                              action: 'abandon',
                              operationId: baseline.handoff!.operationId,
                              recoveryToken: baseline.recoveryToken,
                            },
                            'Handoff abandoned. Existing client and project records were retained.',
                          );
                      }}
                    >
                      Abandon handoff
                    </button>
                  </div>
                </>
              ) : (
                <p>
                  This handoff is closed. Continue through the available client
                  and project records. Removing the source enquiry does not
                  delete those records.
                </p>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
