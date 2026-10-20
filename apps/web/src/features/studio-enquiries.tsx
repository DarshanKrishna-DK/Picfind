import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { api, HttpError, session } from '../api';
import { ErrorNote, Loading, PageTitle } from '../components/ui';
import {
  ENQUIRY_ACTOR,
  ENQUIRY_CONSENT,
  ENQUIRY_PAGE_SIZE,
  enquiryFormDirectory,
  enquiryFormWrite,
  enquiryInbox,
  enquiryReceipt,
  enquiryStages,
  enquirySubmit,
  publishedEnquiryForm,
  savedEnquiry,
  blankEnquiry,
  type Enquiry,
  type EnquiryForm,
  type EnquiryFields,
} from '../../../../packages/shared/src/studio-enquiries';
import './studio-enquiries.css';

function denied(error: unknown) {
  return error instanceof HttpError && [401, 403].includes(error.status);
}
function useOperation(onDenied?: (error: unknown) => void) {
  const pending = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function run<T>(
    work: (signal: AbortSignal) => Promise<T>,
    done: (value: T) => void,
  ) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    try {
      const value = await work(controller.signal);
      if (!controller.signal.aborted) done(value);
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure);
        if (denied(failure)) onDenied?.(failure);
      }
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return { busy, error, setError, run };
}
export function StudioEnquiries() {
  const account = useQuery({
    queryKey: ['session'],
    queryFn: session,
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  if (account.isPending) return <Loading />;
  if (!account.data || account.error)
    return (
      <ErrorNote
        error={account.error ?? new Error('Sign in to manage enquiries.')}
      />
    );
  return <EnquiryDesk key={account.data.id} accountId={account.data.id} />;
}
function EnquiryDesk({ accountId }: { accountId: string }) {
  const [stage, setStage] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Enquiry | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [accessError, setAccessError] = useState<unknown>(null);
  const leaveEditor = () =>
    !editorDirty ||
    window.confirm(
      'Discard the unsaved follow-up draft before changing this view?',
    );
  const query = useQuery({
    queryKey: ['studio-enquiries', accountId, stage, search, offset],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ offset: String(offset), search });
      if (stage) params.set('stage', stage);
      const value = enquiryInbox.parse(
        await api(`/studio/enquiries?${params}`, {
          signal,
          headers: { [ENQUIRY_ACTOR]: accountId },
        }),
      );
      if (value.accountId !== accountId)
        throw new Error('The signed-in account changed. Reload the studio.');
      return value;
    },
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  const client = useQueryClient();
  const refresh = () => {
    void client.invalidateQueries({
      queryKey: ['studio-enquiries', accountId],
    });
  };
  if (accessError || denied(query.error))
    return <ErrorNote error={accessError ?? query.error} />;
  return (
    <div className="enquiry-desk">
      <PageTitle eyebrow="PHOTOGRAPHER STUDIO" title="Enquiries" />
      <p>
        Receive session requests and track your follow-up. Enquiries are not
        confirmed bookings or payments.
      </p>
      <FormSettings accountId={accountId} onDenied={setAccessError} />
      <section className="source-panel" aria-label="Enquiry inbox">
        <h2>Private enquiry inbox</h2>
        <p>
          Contact details are self-reported and unverified. Stage changes record
          your work; PicFind does not send replies.
        </p>
        <div className="enquiry-controls">
          <label>
            Filter stage
            <select
              value={stage}
              onChange={(e) => {
                if (!leaveEditor()) return;
                setStage(e.target.value);
                setOffset(0);
                setSelected(null);
              }}
            >
              <option value="">All stages</option>
              {enquiryStages.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label>
            Search enquiries
            <input
              value={search}
              maxLength={200}
              onChange={(e) => {
                if (!leaveEditor()) return;
                setSearch(e.target.value);
                setOffset(0);
                setSelected(null);
              }}
            />
          </label>
          <button className="button secondary" type="button" onClick={refresh}>
            Refresh inbox
          </button>
        </div>
        {query.isPending ? (
          <Loading />
        ) : query.error ? (
          <ErrorNote error={query.error} />
        ) : (
          query.data && (
            <>
              <p>
                {query.data.totalCount} retained enquiries.{' '}
                {query.data.filteredCount} match this view. Capacity:{' '}
                {query.data.limit}.
              </p>
              {!query.data.enquiries.length && (
                <p>No enquiries on this page.</p>
              )}
              <div className="enquiry-list">
                {query.data.enquiries.map((row) => (
                  <article key={row.id}>
                    <h3>{row.name}</h3>
                    <p>
                      {row.sessionType} · {row.stage}
                    </p>
                    <p>
                      {row.date || 'Date not specified'} · {row.email}
                    </p>
                    <button
                      className="button secondary"
                      type="button"
                      onClick={() => {
                        if (selected?.id === row.id || leaveEditor())
                          setSelected(row);
                      }}
                    >
                      Review enquiry from {row.name}
                    </button>
                  </article>
                ))}
              </div>
              <div className="enquiry-controls">
                <button
                  className="button secondary"
                  type="button"
                  disabled={!offset}
                  onClick={() => {
                    if (!leaveEditor()) return;
                    setOffset(Math.max(0, offset - ENQUIRY_PAGE_SIZE));
                    setSelected(null);
                  }}
                >
                  Previous enquiries
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={
                    offset + ENQUIRY_PAGE_SIZE >= query.data.filteredCount
                  }
                  onClick={() => {
                    if (!leaveEditor()) return;
                    setOffset(offset + ENQUIRY_PAGE_SIZE);
                    setSelected(null);
                  }}
                >
                  Next enquiries
                </button>
              </div>
            </>
          )
        )}
        {selected && (
          <EnquiryEditor
            key={selected.id}
            initial={selected}
            current={
              query.error
                ? null
                : (query.data?.enquiries.find(
                    (row) => row.id === selected.id,
                  ) ?? null)
            }
            accountId={accountId}
            onDirty={setEditorDirty}
            onDenied={setAccessError}
            onSaved={(row) => {
              setSelected(row);
              refresh();
            }}
            onRemoved={() => {
              setSelected(null);
              refresh();
            }}
          />
        )}
      </section>
    </div>
  );
}

function FormSettings({
  accountId,
  onDenied,
}: {
  accountId: string;
  onDenied: (error: unknown) => void;
}) {
  const query = useQuery({
    queryKey: ['studio-enquiry-form', accountId],
    queryFn: async ({ signal }) => {
      const value = enquiryFormDirectory.parse(
        await api('/studio/enquiry-form', {
          signal,
          headers: { [ENQUIRY_ACTOR]: accountId },
        }),
      );
      if (value.accountId !== accountId)
        throw new Error('The signed-in account changed. Reload the form.');
      return value;
    },
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  useEffect(() => {
    if (denied(query.error)) onDenied(query.error);
  }, [query.error, onDenied]);
  if (query.isPending) return <Loading />;
  if (!query.data || denied(query.error))
    return <ErrorNote error={query.error} />;
  return (
    <>
      <ErrorNote error={query.error} />
      <button
        className="button secondary"
        type="button"
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
      >
        Refresh saved form
      </button>
      <FormEditor
        key={query.data.id}
        accountId={accountId}
        id={query.data.id}
        current={query.data.form}
        blocked={Boolean(query.error)}
        onDenied={onDenied}
      />
    </>
  );
}
function FormEditor({
  accountId,
  id,
  current,
  blocked,
  onDenied,
}: {
  accountId: string;
  id: string;
  current: EnquiryForm | null;
  blocked: boolean;
  onDenied: (error: unknown) => void;
}) {
  const [baseline, setBaseline] = useState(current);
  const fields = (value: EnquiryForm | null) => ({
    name: value?.name ?? '',
    introduction: value?.introduction ?? '',
    enabled: value?.enabled ?? false,
  });
  const [draft, setDraft] = useState(() => fields(current));
  const [message, setMessage] = useState('');
  const operation = useOperation(onDenied),
    client = useQueryClient();
  const stale = blocked || (current?.version ?? 0) !== (baseline?.version ?? 0);
  const dirty = JSON.stringify(draft) !== JSON.stringify(fields(baseline));
  function save(event: FormEvent) {
    event.preventDefault();
    if (stale || operation.busy) return;
    if (
      !baseline?.enabled &&
      draft.enabled &&
      !window.confirm(
        'Publish this studio name, introduction and enquiry form for anyone with the link?',
      )
    )
      return;
    void operation.run(
      async (signal) => {
        const body = enquiryFormWrite.parse({
          ...draft,
          version: baseline?.version ?? 0,
        });
        const value = enquiryFormDirectory.parse(
          await api('/studio/enquiry-form', {
            method: 'PUT',
            signal,
            headers: { [ENQUIRY_ACTOR]: accountId },
            body: JSON.stringify(body),
          }),
        );
        if (value.accountId !== accountId || value.id !== id || !value.form)
          throw new Error(
            'The form reply did not match this account. Reload before continuing.',
          );
        return value;
      },
      (value) => {
        setBaseline(value.form);
        setDraft(fields(value.form));
        client.setQueryData(['studio-enquiry-form', accountId], value);
        setMessage(
          value.form?.enabled
            ? 'Enquiry form published.'
            : 'Enquiry form closed. Existing enquiries remain private.',
        );
      },
    );
  }
  if (denied(operation.error)) return <ErrorNote error={operation.error} />;
  return (
    <section className="source-panel" aria-label="Enquiry form settings">
      <h2>Your public enquiry form</h2>
      <p>
        Only the studio name and introduction are published. Closing the form
        stops new submissions.
      </p>
      <form className="enquiry-form" onSubmit={save}>
        <label>
          Public studio name
          <input
            value={draft.name}
            required
            maxLength={100}
            disabled={operation.busy}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label>
          Public introduction
          <textarea
            value={draft.introduction}
            maxLength={1000}
            disabled={operation.busy}
            onChange={(e) =>
              setDraft({ ...draft, introduction: e.target.value })
            }
          />
        </label>
        <label className="enquiry-checkbox">
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={operation.busy}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          />
          Publish enquiry form
        </label>
        {stale && (
          <p role="alert">
            The saved form changed. Your draft is still here. Load the latest
            form before saving.
          </p>
        )}
        <ErrorNote error={operation.error} />
        <p role="status">{message}</p>
        <div className="enquiry-controls">
          <button
            className="button"
            disabled={operation.busy || stale || !draft.name.trim()}
          >
            Save enquiry form
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={operation.busy || blocked}
            onClick={() => {
              if (
                !dirty ||
                window.confirm(
                  'Discard this draft and load the latest saved form?',
                )
              ) {
                setBaseline(current);
                setDraft(fields(current));
                operation.setError(null);
                setMessage('');
              }
            }}
          >
            Load latest form
          </button>
        </div>
      </form>
      {current?.enabled && (
        <p>
          Published link:{' '}
          <Link to={`/enquire/${id}`}>
            {window.location.origin}/enquire/{id}
          </Link>
        </p>
      )}
    </section>
  );
}

function EnquiryEditor({
  accountId,
  initial,
  current,
  onSaved,
  onRemoved,
  onDirty,
  onDenied,
}: {
  accountId: string;
  initial: Enquiry;
  current: Enquiry | null;
  onSaved: (value: Enquiry) => void;
  onRemoved: () => void;
  onDirty: (dirty: boolean) => void;
  onDenied: (error: unknown) => void;
}) {
  const [baseline, setBaseline] = useState(initial);
  const [stage, setStage] = useState(initial.stage);
  const [note, setNote] = useState(initial.note);
  const [message, setMessage] = useState('');
  const operation = useOperation(onDenied);
  const stale = !current || current.version !== baseline.version;
  const dirty = stage !== baseline.stage || note !== baseline.note;
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  function save(event: FormEvent) {
    event.preventDefault();
    if (stale || operation.busy) return;
    void operation.run(
      async (signal) => {
        const response = await api<{ accountId: string; enquiry: unknown }>(
          `/studio/enquiries/${baseline.id}`,
          {
            method: 'PATCH',
            signal,
            headers: { [ENQUIRY_ACTOR]: accountId },
            body: JSON.stringify({ version: baseline.version, stage, note }),
          },
        );
        const value = savedEnquiry.parse(response.enquiry);
        if (response.accountId !== accountId || value.id !== baseline.id)
          throw new Error(
            'This reply belongs to another enquiry. Reload before continuing.',
          );
        return value;
      },
      (value) => {
        setBaseline(value);
        setStage(value.stage);
        setNote(value.note);
        setMessage('Follow-up saved. No message was sent.');
        onSaved(value);
      },
    );
  }
  if (denied(operation.error)) return <ErrorNote error={operation.error} />;
  return (
    <section className="enquiry-editor" aria-label="Selected enquiry">
      <h3>Request from {baseline.name}</h3>
      <Link
        to={`/app/enquiries/${baseline.id}/handoff`}
        onClick={(event) => {
          if (
            operation.busy ||
            (dirty &&
              !window.confirm(
                'Discard unsaved follow-up changes and open the project handoff?',
              ))
          )
            event.preventDefault();
        }}
      >
        Create or recover project handoff
      </Link>
      <dl>
        <dt>Reply email</dt>
        <dd>{baseline.email}</dd>
        <dt>Phone</dt>
        <dd>{baseline.phone || 'Not provided'}</dd>
        <dt>Session</dt>
        <dd>{baseline.sessionType}</dd>
        <dt>Preferred date</dt>
        <dd>{baseline.date || 'Not specified'}</dd>
      </dl>
      <p className="enquiry-text">{baseline.message}</p>
      <p>
        Received {new Date(baseline.createdAt).toLocaleString()}. Contact
        details are unverified.
      </p>
      <form className="enquiry-form" onSubmit={save}>
        <label>
          Follow-up stage
          <select
            value={stage}
            disabled={operation.busy}
            onChange={(e) => setStage(e.target.value as Enquiry['stage'])}
          >
            {enquiryStages.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          Private follow-up note
          <textarea
            value={note}
            maxLength={1000}
            disabled={operation.busy}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        {stale && (
          <p role="alert">
            This enquiry changed or left the current view. Your draft is
            retained. Refresh and load its latest version.
          </p>
        )}
        <ErrorNote error={operation.error} />
        <p role="status">{message}</p>
        <div className="enquiry-controls">
          <button className="button" disabled={operation.busy || stale}>
            Save follow-up
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={operation.busy || !current}
            onClick={() => {
              if (
                current &&
                (!dirty ||
                  window.confirm(
                    'Discard this follow-up draft and load the latest enquiry?',
                  ))
              ) {
                setBaseline(current);
                setStage(current.stage);
                setNote(current.note);
                operation.setError(null);
                setMessage('');
              }
            }}
          >
            Load latest enquiry
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={operation.busy || stale}
            onClick={() => {
              if (
                window.confirm(
                  'Remove this enquiry, its contact details and private follow-up notes?',
                )
              )
                void operation.run(
                  (signal) =>
                    api(`/studio/enquiries/${baseline.id}`, {
                      method: 'DELETE',
                      signal,
                      headers: { [ENQUIRY_ACTOR]: accountId },
                      body: JSON.stringify({ version: baseline.version }),
                    }),
                  onRemoved,
                );
            }}
          >
            Remove enquiry
          </button>
        </div>
      </form>
      <h4>Recorded follow-up history</h4>
      <ol>
        {baseline.history.map((row, i) => (
          <li key={i}>
            {row.stage}: {new Date(row.at).toLocaleString()}
          </li>
        ))}
      </ol>
    </section>
  );
}

export function PublicEnquiry() {
  const { id = '' } = useParams();
  const query = useQuery({
    queryKey: ['public-enquiry-form', id],
    queryFn: async ({ signal }) =>
      publishedEnquiryForm.parse(
        await api(`/public/enquiries/${id}`, { signal }),
      ),
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  if (query.isPending)
    return (
      <section className="wrap standalone">
        <Loading />
      </section>
    );
  if (
    !query.data ||
    (query.error instanceof HttpError &&
      [401, 403, 404].includes(query.error.status))
  )
    return (
      <section className="wrap standalone">
        <h1>Enquiry form unavailable</h1>
        <p>The photographer may have closed this form.</p>
        <ErrorNote error={query.error} />
        <button
          className="button secondary"
          onClick={() => void query.refetch()}
        >
          Refresh enquiry form
        </button>
      </section>
    );
  return (
    <VisitorForm
      key={id}
      current={query.data}
      readError={query.error}
      refreshing={query.isFetching}
      refresh={() => void query.refetch()}
    />
  );
}
function VisitorForm({
  current,
  refresh,
  readError,
  refreshing,
}: {
  current: { id: string; name: string; introduction: string; version: number };
  refresh: () => void;
  readError: unknown;
  refreshing: boolean;
}) {
  const [baseline, setBaseline] = useState(current);
  const [draft, setDraft] = useState(blankEnquiry);
  const [consent, setConsent] = useState(false);
  const [receipt, setReceipt] = useState<{
    id: string;
    receivedAt: string;
  } | null>(null);
  const requestId = useRef(crypto.randomUUID());
  const operation = useOperation();
  const stale = current.version !== baseline.version;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!consent || stale || readError || refreshing) return;
    void operation.run(
      async (signal) => {
        const body = enquirySubmit.parse({
          ...draft,
          formVersion: baseline.version,
          consent: ENQUIRY_CONSENT,
        });
        const result = enquiryReceipt.parse(
          await api(`/public/enquiries/${baseline.id}/${requestId.current}`, {
            method: 'PUT',
            signal,
            body: JSON.stringify(body),
          }),
        );
        if (result.id !== requestId.current)
          throw new Error(
            'The receipt did not match this request. Retry before starting another enquiry.',
          );
        return result;
      },
      (value) => {
        setReceipt(value);
        setDraft(blankEnquiry());
        setConsent(false);
      },
    );
  }
  const fields: {
    key: keyof EnquiryFields;
    label: string;
    type: string;
    max: number;
    required: boolean;
  }[] = [
    { key: 'name', label: 'Your name', type: 'text', max: 100, required: true },
    {
      key: 'email',
      label: 'Reply email',
      type: 'email',
      max: 254,
      required: true,
    },
    {
      key: 'phone',
      label: 'Phone (optional)',
      type: 'tel',
      max: 40,
      required: false,
    },
    {
      key: 'date',
      label: 'Preferred date (optional)',
      type: 'date',
      max: 10,
      required: false,
    },
    {
      key: 'sessionType',
      label: 'Type of photography',
      type: 'text',
      max: 100,
      required: true,
    },
  ];
  return (
    <section className="wrap standalone enquiry-public">
      <p className="eyebrow">PHOTOGRAPHY ENQUIRY</p>
      <h1>{current.name}</h1>
      <p className="enquiry-text">{current.introduction}</p>
      {receipt ? (
        <div role="status">
          <h2>Enquiry saved</h2>
          <p>
            Your request is in the photographer’s inbox. This is not a confirmed
            booking or payment.
          </p>
          <p>
            Reference: <strong>{receipt.id}</strong>
          </p>
          <p>Received {new Date(receipt.receivedAt).toLocaleString()}.</p>
          <p>Contact the photographer directly for corrections or removal.</p>
        </div>
      ) : (
        <form className="enquiry-form" onSubmit={submit}>
          <p>
            Share your session requirements and a way for this photographer to
            contact you. Do not include payment details or sensitive documents.
          </p>
          {fields.map((field) => (
            <label key={field.key}>
              {field.label}
              <input
                type={field.type}
                value={draft[field.key]}
                required={field.required}
                maxLength={field.max}
                disabled={operation.busy}
                onChange={(e) =>
                  setDraft({ ...draft, [field.key]: e.target.value })
                }
              />
            </label>
          ))}
          <label>
            Session details
            <textarea
              value={draft.message}
              maxLength={2000}
              required
              disabled={operation.busy}
              onChange={(e) => setDraft({ ...draft, message: e.target.value })}
            />
          </label>
          <label className="enquiry-checkbox">
            <input
              type="checkbox"
              checked={consent}
              disabled={operation.busy}
              onChange={(e) => setConsent(e.target.checked)}
            />
            I agree to share these contact details and this request with{' '}
            {current.name} so they can reply about this enquiry.
          </label>
          {stale && (
            <p role="alert">
              The photographer updated this form. Review the current details and
              accept them before sending.
            </p>
          )}
          <ErrorNote error={operation.error} />
          <ErrorNote error={readError} />
          {refreshing && (
            <p role="status">Refreshing published form details.</p>
          )}
          <div className="enquiry-controls">
            <button
              className="button"
              disabled={
                operation.busy ||
                !consent ||
                stale ||
                Boolean(readError) ||
                refreshing
              }
            >
              Send enquiry
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={operation.busy || refreshing}
              onClick={refresh}
            >
              Refresh form details
            </button>
            {stale && (
              <button
                className="button secondary"
                type="button"
                disabled={operation.busy || refreshing || Boolean(readError)}
                onClick={() => {
                  setBaseline(current);
                  setConsent(false);
                  operation.setError(null);
                }}
              >
                Accept updated form details
              </button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
