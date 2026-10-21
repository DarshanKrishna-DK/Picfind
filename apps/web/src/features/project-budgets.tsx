import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, HttpError, session } from '../api';
import { ErrorNote, Loading, PageTitle } from '../components/ui';
import {
  BUDGET_ACTOR,
  budgetCommand,
  budgetReport,
  type BudgetReport,
} from '../../../../packages/shared/src/project-budgets';
import {
  serviceCurrencies,
  decimalToMinor,
  minorToDecimal,
} from '../../../../packages/shared/src/studio-services';
import './project-budgets.css';

type Currency = (typeof serviceCurrencies)[number];
type Draft = { amounts: Record<Currency, string>; note: string };
const draftOf = (report: BudgetReport): Draft => ({
  amounts: Object.fromEntries(
    serviceCurrencies.map((currency) => [
      currency,
      minorToDecimal(
        report.fields.limits.find((row) => row.currency === currency)
          ?.amountMinor ?? null,
      ),
    ]),
  ) as Record<Currency, string>,
  note: report.fields.note,
});
const identity = (report: BudgetReport) =>
  JSON.stringify([report.projectCreatedAt, report.version, report.fields]);
const money = (value: number, currency: string) =>
  new Intl.NumberFormat('en', { style: 'currency', currency }).format(
    value / 100,
  );

export function ProjectBudgets() {
  const { projectId = '' } = useParams();
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
        error={account.error ?? new Error('Sign in to view project budgets.')}
      />
    );
  return (
    <BudgetEditor
      key={`${account.data.id}:${projectId}`}
      accountId={account.data.id}
      projectId={projectId}
    />
  );
}
function BudgetEditor({
  accountId,
  projectId,
}: {
  accountId: string;
  projectId: string;
}) {
  const cache = useQueryClient(),
    key = ['project-budget', accountId, projectId],
    endpoint = `/studio/projects/${projectId}/budget`;
  const checked = (value: unknown) => {
    const report = budgetReport.parse(value);
    if (report.accountId !== accountId || report.projectId !== projectId)
      throw new HttpError(
        403,
        'This budget belongs to another account or project.',
      );
    return report;
  };
  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => checked(await api(endpoint, { signal })),
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  const [baseline, setBaseline] = useState<BudgetReport | null>(null),
    [draft, setDraft] = useState<Draft | null>(null),
    [busy, setBusy] = useState(false),
    [conflict, setConflict] = useState(false),
    [error, setError] = useState<unknown>(null),
    [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (!baseline && query.data) {
      setBaseline(query.data);
      setDraft(draftOf(query.data));
    }
  }, [baseline, query.data]);
  const denied = [query.error, error].some(
    (failure) =>
      failure instanceof HttpError && [401, 403, 404].includes(failure.status),
  );
  const stale =
    conflict ||
    !!query.error ||
    !!(baseline && query.data && identity(baseline) !== identity(query.data));
  function adopt(report: BudgetReport) {
    setBaseline(report);
    setDraft(draftOf(report));
    setConflict(false);
    setError(null);
    cache.setQueryData(key, report);
  }
  async function refresh() {
    if (busy || query.isFetching) return;
    if (
      draft &&
      baseline &&
      JSON.stringify(draft) !== JSON.stringify(draftOf(baseline)) &&
      !window.confirm(
        'Discard the unsaved budget draft and load the latest budget?',
      )
    )
      return;
    setMessage('');
    setError(null);
    const result = await query.refetch();
    if (result.data && !result.error) adopt(result.data);
  }
  const command = budgetCommand.safeParse({
    projectCreatedAt: baseline?.projectCreatedAt,
    version: baseline?.version,
    fields: {
      note: draft?.note,
      limits: draft
        ? serviceCurrencies
            .filter((currency) => draft.amounts[currency].trim() !== '')
            .map((currency) => ({
              currency,
              amountMinor: decimalToMinor(draft.amounts[currency]),
            }))
        : [],
    },
  });
  async function save(event: FormEvent) {
    event.preventDefault();
    if (
      !command.success ||
      busy ||
      stale ||
      query.isFetching ||
      pending.current
    )
      return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      const report = checked(
        await api(endpoint, {
          method: 'PUT',
          signal: controller.signal,
          headers: { [BUDGET_ACTOR]: accountId },
          body: JSON.stringify(command.data),
        }),
      );
      controller.signal.throwIfAborted();
      adopt(report);
      setMessage('Project cost budget saved.');
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure);
        if (failure instanceof HttpError && failure.status === 409)
          setConflict(true);
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (pending.current === controller) pending.current = null;
    }
  }
  if (denied) return <ErrorNote error={query.error ?? error} />;
  if (!baseline || !draft)
    return query.error ? (
      <div>
        <ErrorNote error={query.error} />
        <button type="button" onClick={() => void refresh()}>
          Retry budget
        </button>
      </div>
    ) : (
      <Loading />
    );
  const report = query.data ?? baseline;
  return (
    <section className="project-budget stack">
      <PageTitle eyebrow={report.projectName} title="Project cost budget" />
      <p>
        <Link to="/app/projects">Back to projects</Link> ·{' '}
        <Link to={`/app/expenses?project=${encodeURIComponent(projectId)}`}>
          Review linked expenses
        </Link>
      </p>
      <p>
        Compare planned costs with your recorded expenses and refunds.
        Currencies remain separate. This snapshot does not calculate profit, tax
        or payment status.
      </p>
      {query.error && <ErrorNote error={query.error} />}
      {!!error && <ErrorNote error={error} />}
      {stale && (
        <p role="alert">
          The budget changed or could not be refreshed. Your draft is preserved.
          Load the latest budget before saving.
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <button
        type="button"
        className="button secondary"
        disabled={busy || query.isFetching}
        onClick={() => void refresh()}
      >
        Load latest budget
      </button>
      <form
        className="glass-panel budget-editor"
        onSubmit={(event) => void save(event)}
      >
        <h2>Planned cost limits</h2>
        <p>
          Leave a currency blank for no budget. Enter 0 for an intentional zero
          limit. Maximum per currency: 10,000,000.00.
        </p>
        <fieldset disabled={busy || stale || query.isFetching}>
          <legend>Currency limits</legend>
          <div className="budget-inputs">
            {serviceCurrencies.map((currency) => (
              <label key={currency}>
                {currency} budget
                <input
                  inputMode="decimal"
                  value={draft.amounts[currency]}
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      amounts: {
                        ...draft.amounts,
                        [currency]: event.target.value,
                      },
                    });
                    setMessage('');
                  }}
                />
              </label>
            ))}
          </div>
          <label>
            Private budget note
            <textarea
              maxLength={1000}
              value={draft.note}
              onChange={(event) => {
                setDraft({ ...draft, note: event.target.value });
                setMessage('');
              }}
            />
          </label>
          {!command.success && (
            <p role="alert">
              Use nonnegative amounts with at most two decimal places and a
              shorter note.
            </p>
          )}
          <button
            type="submit"
            className="button primary"
            disabled={!command.success}
          >
            Save budget
          </button>
        </fieldset>
      </form>
      {!query.error && (
        <section aria-label="Recorded cost comparison">
          <h2>Recorded cost comparison</h2>
          <p>
            {report.verifiedEntries} verified journal entries. Checked{' '}
            <time dateTime={report.checkedAt}>
              {new Date(report.checkedAt).toLocaleString()}
            </time>
            .
          </p>
          {report.unverifiedLinks > 0 && (
            <p role="alert">
              {report.unverifiedLinks} older project links need review and are
              excluded from these totals. Open the linked expenses, review each
              project link and explicitly confirm it before saving.
            </p>
          )}
          {report.historicalLinks > 0 && (
            <p>
              {report.historicalLinks} entries belong to an earlier project with
              the same identifier. They remain in the journal and are excluded
              here.
            </p>
          )}
          {!report.currencies.length && (
            <p>No budget limits or verified expenses recorded yet.</p>
          )}
          <div className="budget-comparisons">
            {report.currencies.map((row) => (
              <article className="glass-panel" key={row.currency}>
                <h3>{row.currency}</h3>
                <dl>
                  <dt>Planned limit</dt>
                  <dd>
                    {row.budget === null
                      ? 'No budget set'
                      : money(row.budget, row.currency)}
                  </dd>
                  <dt>Expenses</dt>
                  <dd>{money(row.expenses, row.currency)}</dd>
                  <dt>Refunds</dt>
                  <dd>{money(row.refunds, row.currency)}</dd>
                  <dt>Net recorded cost</dt>
                  <dd>{money(row.net, row.currency)}</dd>
                  {row.remaining !== null && (
                    <>
                      <dt>Remaining</dt>
                      <dd>{money(row.remaining, row.currency)}</dd>
                    </>
                  )}
                  {row.overBudget !== null && (
                    <>
                      <dt>Over budget</dt>
                      <dd>{money(row.overBudget, row.currency)}</dd>
                    </>
                  )}
                </dl>
              </article>
            ))}
          </div>
          <p>
            Only saved limits are used in this comparison. Refresh after editing
            expenses elsewhere.
          </p>
        </section>
      )}
    </section>
  );
}
