import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, HttpError, saveFile, session } from '../api';
import { ErrorNote, Loading, PageTitle } from '../components/ui';
import {
  SERVICE_ACTOR,
  SERVICE_PAGE_SIZE,
  blankService,
  decimalToMinor,
  minorToDecimal,
  savedService,
  serviceCatalog,
  serviceCurrencies,
  serviceExport,
  serviceCsv,
  servicePrice,
  serviceWrite,
  type ServiceFields,
  type StudioService,
} from '../../../../packages/shared/src/studio-services';
import './studio-services.css';

const denied = (error: unknown) =>
  error instanceof HttpError && [401, 403].includes(error.status);
export function StudioServices() {
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
        error={account.error ?? new Error('Sign in to manage services.')}
      />
    );
  return <Catalog key={account.data.id} accountId={account.data.id} />;
}
function Catalog({ accountId }: { accountId: string }) {
  const client = useQueryClient();
  const refreshSavedViews = () =>
    void client.invalidateQueries({ queryKey: ['studio-services', accountId] });
  const [state, setState] = useState('active'),
    [search, setSearch] = useState(''),
    [offset, setOffset] = useState(0);
  const [baseline, setBaseline] = useState<StudioService | null>(null),
    [draft, setDraft] = useState(blankService),
    [amount, setAmount] = useState(''),
    [duration, setDuration] = useState(''),
    [deliverables, setDeliverables] = useState('');
  const [editorId, setEditorId] = useState(() => crypto.randomUUID() as string),
    [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const headers = { [SERVICE_ACTOR]: accountId };
  const query = useQuery({
    queryKey: ['studio-services', accountId, state, search, offset],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({
        state,
        search,
        offset: String(offset),
      });
      const value = serviceCatalog.parse(
        await api(`/studio/services?${params}`, { signal, headers }),
      );
      if (value.accountId !== accountId)
        throw new HttpError(
          403,
          'The signed-in account changed. Reload the catalog.',
        );
      return value;
    },
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  const current = query.data?.services.find((row) => row.id === editorId);
  const stale =
    Boolean(query.error) ||
    (baseline !== null && current?.version !== baseline.version);
  const fieldsOf = (row: StudioService | null): ServiceFields =>
    row
      ? {
          title: row.title,
          description: row.description,
          deliverables: row.deliverables,
          durationMinutes: row.durationMinutes,
          pricingMode: row.pricingMode,
          currency: row.currency,
          amountMinor: row.amountMinor,
          archived: row.archived,
        }
      : blankService();
  const dirty =
    editing &&
    (JSON.stringify(draft) !== JSON.stringify(fieldsOf(baseline)) ||
      amount !== minorToDecimal(baseline?.amountMinor ?? null) ||
      duration !== (baseline?.durationMinutes?.toString() ?? '') ||
      deliverables !== (baseline?.deliverables.join('\n') ?? ''));
  const leave = () =>
    !dirty || window.confirm('Discard this unsaved service draft?');
  function load(row: StudioService | null) {
    setBaseline(row);
    setDraft(fieldsOf(row));
    setAmount(minorToDecimal(row?.amountMinor ?? null));
    setDuration(row?.durationMinutes?.toString() ?? '');
    setDeliverables(row?.deliverables.join('\n') ?? '');
    setEditorId(row?.id ?? crypto.randomUUID());
    setEditing(true);
    setError(null);
    setMessage('');
  }
  async function run<T>(
    work: (signal: AbortSignal) => Promise<T>,
    done: (value: T) => void,
  ) {
    if (pending.current) return;
    const controller = new AbortController();
    const destination = window.location.pathname + window.location.search;
    const active = () =>
      !controller.signal.aborted &&
      destination === window.location.pathname + window.location.search;
    pending.current = controller;
    setBusy(true);
    setError(null);
    try {
      const value = await work(controller.signal);
      if (active()) done(value);
    } catch (failure) {
      if (active()) setError(failure);
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (stale || busy) return;
    void run(
      async (signal) => {
        const amountMinor =
          draft.pricingMode === 'quote' ? null : decimalToMinor(amount);
        if (draft.pricingMode !== 'quote' && amountMinor === null)
          throw new Error(
            'Enter an amount with at most two decimal places, up to 10,000,000.',
          );
        if (duration && !/^\d{1,4}$/.test(duration))
          throw new Error(
            'Enter whole minutes between 1 and 1440, or leave duration blank.',
          );
        const body = serviceWrite.parse({
          ...draft,
          amountMinor,
          durationMinutes: duration ? Number(duration) : null,
          deliverables: deliverables
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
          version: baseline?.version ?? 0,
        });
        const response = await api<{ accountId: string; service: unknown }>(
          `/studio/services/${editorId}`,
          {
            method: 'PUT',
            signal,
            headers,
            body: JSON.stringify(body),
          },
        );
        if (response.accountId !== accountId)
          throw new HttpError(
            403,
            'The signed-in account changed. Reload the catalog.',
          );
        const row = savedService.parse(response.service);
        if (row.id !== editorId)
          throw new Error(
            'The saved reply belongs to another service. Refresh before continuing.',
          );
        return row;
      },
      (row) => {
        load(row);
        if (state !== 'all' && row.archived !== (state === 'archived'))
          setEditing(false);
        setMessage('Service saved privately.');
        refreshSavedViews();
      },
    );
  }
  function changeView(change: () => void) {
    if (!leave()) return;
    setEditing(false);
    setOffset(0);
    setError(null);
    setMessage('');
    change();
  }
  function exportCsv() {
    void run(
      async (signal) => {
        const params = new URLSearchParams({ state, search });
        const value = serviceExport.parse(
          await api(`/studio/services/export?${params}`, { signal, headers }),
        );
        if (value.accountId !== accountId)
          throw new HttpError(
            403,
            'The signed-in account changed. Reload the catalog.',
          );
        return value.services;
      },
      (rows) => {
        saveFile(
          new Blob([serviceCsv(rows)], { type: 'text/csv;charset=utf-8' }),
          'picfind-private-services.csv',
        );
        setMessage(
          `CSV download started for ${rows.length} saved services in this view.`,
        );
      },
    );
  }
  if (denied(error) || denied(query.error))
    return <ErrorNote error={denied(error) ? error : query.error} />;
  return (
    <div className="service-catalog">
      <PageTitle eyebrow="PHOTOGRAPHER STUDIO" title="Services" />
      <p>
        Keep reusable session packages and your indicative prices private. These
        records do not create bookings, invoices or client acceptance.
      </p>
      <div className="service-controls">
        <label>
          Catalog view
          <select
            value={state}
            disabled={busy}
            onChange={(e) => changeView(() => setState(e.target.value))}
          >
            <option value="active">Active services</option>
            <option value="archived">Archived services</option>
            <option value="all">All services</option>
          </select>
        </label>
        <label>
          Search services
          <input
            value={search}
            maxLength={200}
            disabled={busy}
            onChange={(e) => changeView(() => setSearch(e.target.value))}
          />
        </label>
        <button
          className="button secondary"
          disabled={busy || query.isFetching}
          onClick={() => void query.refetch()}
        >
          Refresh catalog
        </button>
        <button
          className="button secondary"
          disabled={busy}
          onClick={exportCsv}
        >
          Export saved view CSV
        </button>
        <button
          className="button"
          disabled={busy || !query.data || Boolean(query.error)}
          onClick={() => {
            if (leave()) load(null);
          }}
        >
          New service
        </button>
      </div>
      <ErrorNote error={query.error} />
      <ErrorNote error={error} />
      <p role="status">{message}</p>
      {query.isPending ? (
        <Loading />
      ) : (
        !query.error &&
        query.data && (
          <>
            <p>
              {query.data.totalCount} retained services.{' '}
              {query.data.filteredCount} match this view. Capacity:{' '}
              {query.data.limit}. Archived services count towards capacity.
            </p>
            <div className="service-list">
              {query.data.services.map((row) => (
                <article key={row.id}>
                  <h2>{row.title}</h2>
                  <p>{servicePrice(row)}</p>
                  <p>
                    {row.archived ? 'Archived' : 'Active'} · Version{' '}
                    {row.version}
                  </p>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => {
                      if (leave()) load(row);
                    }}
                  >
                    Edit service: {row.title}
                  </button>
                </article>
              ))}
            </div>
            {!query.data.services.length && <p>No services in this view.</p>}
            <div className="service-controls">
              <button
                className="button secondary"
                disabled={busy || !offset}
                onClick={() => {
                  if (leave()) {
                    setEditing(false);
                    setOffset(Math.max(0, offset - SERVICE_PAGE_SIZE));
                  }
                }}
              >
                Previous services
              </button>
              <button
                className="button secondary"
                disabled={
                  busy || offset + SERVICE_PAGE_SIZE >= query.data.filteredCount
                }
                onClick={() => {
                  if (leave()) {
                    setEditing(false);
                    setOffset(offset + SERVICE_PAGE_SIZE);
                  }
                }}
              >
                Next services
              </button>
            </div>
          </>
        )
      )}
      {editing && (
        <section className="source-panel" aria-label="Service editor">
          <h2>{baseline ? 'Edit saved service' : 'New private service'}</h2>
          <form className="service-form" onSubmit={save}>
            <label>
              Service title
              <input
                value={draft.title}
                required
                maxLength={100}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </label>
            <label>
              Service description
              <textarea
                value={draft.description}
                maxLength={2000}
                disabled={busy}
                onChange={(e) =>
                  setDraft({ ...draft, description: e.target.value })
                }
              />
            </label>
            <label>
              Deliverables, one per line
              <textarea
                value={deliverables}
                maxLength={4020}
                disabled={busy}
                onChange={(e) => setDeliverables(e.target.value)}
              />
            </label>
            <p>
              Up to 20 deliverables, 200 characters each. Blank lines are
              ignored.
            </p>
            <label>
              Session duration in minutes (optional)
              <input
                inputMode="numeric"
                value={duration}
                maxLength={4}
                disabled={busy}
                onChange={(e) => setDuration(e.target.value)}
              />
            </label>
            <label>
              Pricing mode
              <select
                value={draft.pricingMode}
                disabled={busy}
                onChange={(e) => {
                  const mode = e.target.value as ServiceFields['pricingMode'];
                  setDraft({
                    ...draft,
                    pricingMode: mode,
                    ...(mode === 'quote' ? { amountMinor: null } : {}),
                  });
                  if (mode === 'quote') setAmount('');
                }}
              >
                <option value="quote">Request a quote</option>
                <option value="fixed">Fixed package price</option>
                <option value="starting">Starting price</option>
              </select>
            </label>
            <label>
              Service currency
              <select
                value={draft.currency}
                disabled={busy}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    currency: e.target.value as ServiceFields['currency'],
                  })
                }
              >
                {serviceCurrencies.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            {draft.pricingMode !== 'quote' && (
              <label>
                Package amount
                <input
                  inputMode="decimal"
                  value={amount}
                  required
                  maxLength={12}
                  disabled={busy}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </label>
            )}
            <p>
              Amounts use two decimal places. PicFind does not calculate taxes
              or collect payment from these records.
            </p>
            <label className="service-checkbox">
              <input
                type="checkbox"
                checked={draft.archived}
                disabled={busy}
                onChange={(e) =>
                  setDraft({ ...draft, archived: e.target.checked })
                }
              />
              Archive service
            </label>
            {stale && (
              <p role="alert">
                This service changed or is outside the current view. Your draft
                is retained. Refresh and load its latest version.
              </p>
            )}
            <div className="service-controls">
              <button
                className="button"
                disabled={busy || stale || !draft.title.trim()}
              >
                Save service
              </button>
              <button
                className="button secondary"
                type="button"
                disabled={busy || !current || Boolean(query.error)}
                onClick={() => {
                  if (current && leave()) load(current);
                }}
              >
                Load latest service
              </button>
              <button
                className="button secondary"
                type="button"
                disabled={busy}
                onClick={() => {
                  if (leave()) setEditing(false);
                }}
              >
                Close service editor
              </button>
              {baseline?.archived && (
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy || stale}
                  onClick={() => {
                    if (
                      !window.confirm(
                        'Permanently remove this archived service from your private catalog?',
                      )
                    )
                      return;
                    void run(
                      (signal) =>
                        api(`/studio/services/${editorId}`, {
                          method: 'DELETE',
                          signal,
                          headers,
                          body: JSON.stringify({ version: baseline.version }),
                        }),
                      () => {
                        setEditing(false);
                        setMessage('Archived service removed.');
                        refreshSavedViews();
                      },
                    );
                  }}
                >
                  Remove archived service
                </button>
              )}
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
