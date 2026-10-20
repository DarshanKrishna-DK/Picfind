import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api, HttpError, saveFile, session } from '../api';
import { ErrorNote, Loading, PageTitle } from '../components/ui';
import {
  EXPENSE_ACTOR,
  EXPENSE_PAGE_SIZE,
  blankExpense,
  expenseCategories,
  expenseCsv,
  expenseExport,
  expenseJournal,
  expenseView,
  expenseWrite,
  savedExpense,
  type ExpenseFields,
  type ExpenseView,
  type StudioExpense,
} from '../../../../packages/shared/src/studio-expenses';
import {
  decimalToMinor,
  minorToDecimal,
  serviceCurrencies,
} from '../../../../packages/shared/src/studio-services';
import './studio-expenses.css';

const denied = (error: unknown) =>
  error instanceof HttpError && [401, 403].includes(error.status);
const price = (amount: number, currency: string) =>
  new Intl.NumberFormat('en', { style: 'currency', currency }).format(
    amount / 100,
  );
const label = (value: string) => value[0]!.toUpperCase() + value.slice(1);
function blank(): ExpenseFields {
  const now = new Date();
  return {
    ...blankExpense(),
    incurredOn: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
  };
}
const fieldsOf = (row: StudioExpense | null): ExpenseFields =>
  row
    ? {
        title: row.title,
        merchant: row.merchant,
        category: row.category,
        incurredOn: row.incurredOn,
        direction: row.direction,
        currency: row.currency,
        amountMinor: row.amountMinor,
        reference: row.reference,
        note: row.note,
        projectId: row.projectId,
      }
    : blank();
export function StudioExpenses() {
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
        error={account.error ?? new Error('Sign in to manage expenses.')}
      />
    );
  return <Journal key={account.data.id} accountId={account.data.id} />;
}
function Journal({ accountId }: { accountId: string }) {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState({
      direction: 'all',
      category: 'all',
      from: '',
      to: '',
      project: 'all',
      search: '',
    }),
    [offset, setOffset] = useState(0),
    [baseline, setBaseline] = useState<StudioExpense | null>(null),
    [draft, setDraft] = useState(blank),
    [amount, setAmount] = useState(''),
    [editorId, setEditorId] = useState<string>(() => crypto.randomUUID()),
    [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  const editor = useRef<HTMLFormElement | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (editing) editor.current?.scrollIntoView({ block: 'start' });
  }, [editing, editorId]);
  const headers = { [EXPENSE_ACTOR]: accountId };
  const query = useQuery({
    queryKey: ['studio-expenses', accountId, filters, offset],
    retry: false,
    refetchOnWindowFocus: 'always',
    queryFn: async ({ signal }) => {
      const data = expenseJournal.parse(
        await api(
          `/studio/expenses?${new URLSearchParams({ ...filters, offset: String(offset) })}`,
          { signal, headers },
        ),
      );
      if (data.accountId !== accountId)
        throw new HttpError(
          403,
          'The signed-in account changed. Reload the journal.',
        );
      return data;
    },
  });
  const current = query.data?.entries.find(
    (row) => row.entry.id === editorId,
  )?.entry;
  const stale =
    !!query.error ||
    (baseline !== null &&
      current !== undefined &&
      (baseline.version !== current.version ||
        baseline.generation !== current.generation));
  const dirty =
    editing &&
    (JSON.stringify(draft) !== JSON.stringify(fieldsOf(baseline)) ||
      amount !== minorToDecimal(baseline?.amountMinor ?? null));
  const leave = () =>
    !dirty || window.confirm('Discard this unsaved expense draft?');
  function load(row: StudioExpense | null) {
    setBaseline(row);
    setDraft(fieldsOf(row));
    setAmount(minorToDecimal(row?.amountMinor ?? null));
    setEditorId(row?.id ?? crypto.randomUUID());
    setEditing(true);
    setError(null);
    setMessage('');
  }
  async function run<T>(
    work: (signal: AbortSignal) => Promise<T>,
    done: (result: T) => void,
  ) {
    if (pending.current) return;
    const controller = new AbortController(),
      destination = window.location.pathname + window.location.search;
    const active = () =>
      !controller.signal.aborted &&
      destination === window.location.pathname + window.location.search;
    pending.current = controller;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      const result = await work(controller.signal);
      if (active()) done(result);
    } catch (failure) {
      if (active()) setError(failure);
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  function refresh() {
    void queryClient.invalidateQueries({
      queryKey: ['studio-expenses', accountId],
    });
  }
  function setFilter(key: keyof typeof filters, value: string) {
    if (!leave()) return;
    setEditing(false);
    setFilters({ ...filters, [key]: value });
    setOffset(0);
    setError(null);
  }
  const amountMinor = decimalToMinor(amount);
  const command = expenseWrite.safeParse({
    ...draft,
    amountMinor,
    version: baseline?.version ?? 0,
    generation: baseline?.generation ?? null,
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!command.success || stale || query.isFetching || busy) return;
    void run(
      async (signal) => {
        const value = z
          .object({ accountId: z.string(), entry: savedExpense })
          .strict()
          .parse(
            await api(`/studio/expenses/${editorId}`, {
              method: 'PUT',
              signal,
              headers,
              body: JSON.stringify(command.data),
            }),
          );
        if (
          value.accountId !== accountId ||
          value.entry.id !== editorId ||
          (baseline && value.entry.generation !== baseline.generation)
        )
          throw new HttpError(
            403,
            'This saved entry belongs to another account or record.',
          );
        return value.entry;
      },
      (value) => {
        load(value);
        setMessage('Journal entry saved.');
        refresh();
      },
    );
  }
  function remove() {
    if (
      !baseline ||
      !window.confirm(
        'Remove this journal entry? Export a copy first if you need to keep it.',
      )
    )
      return;
    void run(
      (signal) =>
        api(`/studio/expenses/${baseline.id}`, {
          method: 'DELETE',
          signal,
          headers,
          body: JSON.stringify({
            version: baseline.version,
            generation: baseline.generation,
          }),
        }),
      () => {
        setEditing(false);
        setBaseline(null);
        setMessage('Journal entry removed.');
        refresh();
      },
    );
  }
  function latest() {
    if (!baseline || !leave()) return;
    void run(async (signal) => {
      const value = expenseView
        .extend({ accountId: z.string() })
        .strict()
        .parse(
          await api(`/studio/expenses/${baseline.id}`, { signal, headers }),
        );
      if (value.accountId !== accountId || value.entry.id !== baseline.id)
        throw new HttpError(403, 'This entry belongs to another account.');
      return value.entry;
    }, load);
  }
  function exportRows() {
    void run(
      async (signal) => {
        const data = expenseExport.parse(
          await api(`/studio/expenses/export?${new URLSearchParams(filters)}`, {
            signal,
            headers,
          }),
        );
        if (data.accountId !== accountId)
          throw new HttpError(403, 'This export belongs to another account.');
        return expenseCsv(data.entries);
      },
      (csv) => {
        saveFile(
          new Blob([csv], { type: 'text/csv;charset=utf-8' }),
          'picfind-expenses.csv',
        );
        setMessage('All matching journal entries exported.');
      },
    );
  }
  if (denied(error) || denied(query.error))
    return (
      <section className="glass-panel">
        <h1>Expense journal unavailable</h1>
        <ErrorNote error={error || query.error} />
      </section>
    );
  return (
    <section className="expense-page">
      <PageTitle title="Expenses" eyebrow="Private studio journal" />
      <p>
        These are records you enter yourself. Totals stay separate by currency
        and do not verify payments or calculate tax.
      </p>
      <ErrorNote error={error || query.error} />
      <p role="status">{message}</p>
      <div className="expense-actions">
        <button
          className="button"
          disabled={busy || query.isFetching || !!query.error}
          onClick={() => {
            if (leave()) load(null);
          }}
        >
          New entry
        </button>
        <button
          className="button secondary"
          disabled={busy || query.isFetching}
          onClick={() =>
            void run(
              async () => {
                const result = await query.refetch();
                if (result.error) throw result.error;
              },
              () => setMessage('Journal refreshed.'),
            )
          }
        >
          Reload journal
        </button>
        <button
          className="button secondary"
          disabled={busy || query.isFetching || !!query.error}
          onClick={exportRows}
        >
          Export all matching entries
        </button>
      </div>
      <fieldset className="expense-filters" disabled={busy}>
        <legend>Filter journal entries</legend>
        <label>
          Direction
          <select
            value={filters.direction}
            onChange={(event) => setFilter('direction', event.target.value)}
          >
            <option value="all">Expenses and refunds</option>
            <option value="expense">Expenses</option>
            <option value="refund">Refunds</option>
          </select>
        </label>
        <label>
          Category filter
          <select
            value={filters.category}
            onChange={(event) => setFilter('category', event.target.value)}
          >
            <option value="all">All categories</option>
            {expenseCategories.map((value) => (
              <option key={value} value={value}>
                {label(value)}
              </option>
            ))}
          </select>
        </label>
        <label>
          From date
          <input
            type="date"
            value={filters.from}
            onChange={(event) => setFilter('from', event.target.value)}
          />
        </label>
        <label>
          To date
          <input
            type="date"
            value={filters.to}
            onChange={(event) => setFilter('to', event.target.value)}
          />
        </label>
        <label>
          Project filter
          <select
            value={filters.project}
            onChange={(event) => setFilter('project', event.target.value)}
          >
            <option value="all">All projects</option>
            <option value="none">Studio overhead</option>
            {query.data?.projects.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Search journal
          <input
            type="search"
            maxLength={200}
            value={filters.search}
            onChange={(event) => setFilter('search', event.target.value)}
          />
        </label>
      </fieldset>
      {query.isPending && <Loading />}
      {query.data && (
        <>
          <div className="expense-totals" aria-label="Complete filtered totals">
            {query.data.totals.map((total) => (
              <article className="glass-panel" key={total.currency}>
                <h2>{total.currency}</h2>
                <p>Expenses: {price(total.expenses, total.currency)}</p>
                <p>Refunds: {price(total.refunds, total.currency)}</p>
                <strong>Net cost: {price(total.net, total.currency)}</strong>
              </article>
            ))}
          </div>
          <p>
            {query.data.filteredCount} matching entries. {query.data.totalCount}{' '}
            of {query.data.limit} retained entries.
          </p>
          <div className="expense-layout">
            <div className="expense-list">
              {query.data.entries.length === 0 && (
                <p>No entries match these filters.</p>
              )}
              {query.data.entries.map((row: ExpenseView) => (
                <button
                  className="glass-panel expense-row"
                  key={row.entry.id}
                  disabled={busy}
                  aria-label={`Edit entry: ${row.entry.title}`}
                  onClick={() => {
                    if (leave()) load(row.entry);
                  }}
                >
                  <strong>{row.entry.title}</strong>
                  <span>
                    {row.entry.incurredOn} · {label(row.entry.category)}
                  </span>
                  <span>
                    {label(row.entry.direction)}:{' '}
                    {price(row.entry.amountMinor, row.entry.currency)}
                  </span>
                  <small>
                    {row.projectUnavailable
                      ? 'Unavailable project'
                      : (row.projectName ?? 'Studio overhead')}
                  </small>
                </button>
              ))}
              <div className="expense-actions">
                <button
                  className="button secondary"
                  disabled={busy || offset === 0}
                  onClick={() => {
                    if (leave()) {
                      setEditing(false);
                      setOffset(Math.max(0, offset - EXPENSE_PAGE_SIZE));
                    }
                  }}
                >
                  Previous entries
                </button>
                <button
                  className="button secondary"
                  disabled={
                    busy ||
                    offset + EXPENSE_PAGE_SIZE >= query.data.filteredCount
                  }
                  onClick={() => {
                    if (leave()) {
                      setEditing(false);
                      setOffset(offset + EXPENSE_PAGE_SIZE);
                    }
                  }}
                >
                  Next entries
                </button>
              </div>
            </div>
            {editing && (
              <form
                ref={editor}
                className="glass-panel expense-form"
                onSubmit={submit}
              >
                <h2>{baseline ? 'Edit journal entry' : 'New journal entry'}</h2>
                {stale && (
                  <p role="alert">
                    The saved journal changed or could not be refreshed. Your
                    draft is preserved. Reload and load the latest entry before
                    saving.
                  </p>
                )}
                <fieldset disabled={busy}>
                  <label>
                    Entry title
                    <input
                      required
                      maxLength={120}
                      value={draft.title}
                      onChange={(event) =>
                        setDraft({ ...draft, title: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Expense or refund
                    <select
                      value={draft.direction}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          direction: event.target
                            .value as ExpenseFields['direction'],
                        })
                      }
                    >
                      <option value="expense">Expense</option>
                      <option value="refund">Refund</option>
                    </select>
                  </label>
                  <label>
                    Date incurred
                    <input
                      type="date"
                      required
                      value={draft.incurredOn}
                      onChange={(event) =>
                        setDraft({ ...draft, incurredOn: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Category
                    <select
                      value={draft.category}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          category: event.target
                            .value as ExpenseFields['category'],
                        })
                      }
                    >
                      {expenseCategories.map((value) => (
                        <option key={value} value={value}>
                          {label(value)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Merchant or payee
                    <input
                      maxLength={120}
                      value={draft.merchant}
                      onChange={(event) =>
                        setDraft({ ...draft, merchant: event.target.value })
                      }
                    />
                  </label>
                  <div className="expense-money">
                    <label>
                      Currency
                      <select
                        value={draft.currency}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            currency: event.target
                              .value as ExpenseFields['currency'],
                          })
                        }
                      >
                        {serviceCurrencies.map((value) => (
                          <option key={value}>{value}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Amount
                      <input
                        inputMode="decimal"
                        required
                        value={amount}
                        onChange={(event) => setAmount(event.target.value)}
                      />
                    </label>
                  </div>
                  {amount && (amountMinor === null || amountMinor === 0) && (
                    <p role="alert">
                      Enter a positive amount with at most two decimal places,
                      up to 10,000,000.00.
                    </p>
                  )}
                  <label>
                    Linked project
                    <select
                      value={draft.projectId ?? ''}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          projectId: event.target.value || null,
                        })
                      }
                    >
                      <option value="">Studio overhead</option>
                      {draft.projectId &&
                        !query.data.projects.some(
                          (row) => row.id === draft.projectId,
                        ) && (
                          <option value={draft.projectId}>
                            Unavailable project. Clear this link to save.
                          </option>
                        )}
                      {query.data.projects.map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Receipt or reference
                    <input
                      maxLength={100}
                      value={draft.reference}
                      onChange={(event) =>
                        setDraft({ ...draft, reference: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Private note
                    <textarea
                      maxLength={1000}
                      value={draft.note}
                      onChange={(event) =>
                        setDraft({ ...draft, note: event.target.value })
                      }
                    />
                  </label>
                </fieldset>
                <div className="expense-actions">
                  <button
                    className="button"
                    disabled={
                      busy || query.isFetching || stale || !command.success
                    }
                  >
                    Save entry
                  </button>
                  {baseline && (
                    <>
                      <button
                        type="button"
                        className="button secondary"
                        disabled={busy || query.isFetching || !!query.error}
                        onClick={latest}
                      >
                        Load latest entry
                      </button>
                      <button
                        type="button"
                        className="button secondary"
                        disabled={busy || query.isFetching || stale}
                        onClick={remove}
                      >
                        Remove entry
                      </button>
                    </>
                  )}
                </div>
              </form>
            )}
          </div>
        </>
      )}
    </section>
  );
}
