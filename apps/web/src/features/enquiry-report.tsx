import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, HttpError, saveFile, session } from '../api';
import { ErrorNote, Loading, PageTitle } from '../components/ui';
import { enquiryStages } from '../../../../packages/shared/src/studio-enquiries';
import {
  ENQUIRY_REPORT_ACTOR,
  blankEnquiryReportFilters,
  enquiryReportFilters,
  enquiryReport,
  enquiryReportCounts,
  enquiryReportCsv,
  type EnquiryReportFilters,
} from '../../../../packages/shared/src/enquiry-report';
import './enquiry-report.css';
import { exportNavigationGuard } from '../export-navigation';
export function StudioEnquiryReport() {
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
        error={account.error ?? new Error('Sign in to review enquiries.')}
      />
    );
  return <Report key={account.data.id} accountId={account.data.id} />;
}
function Report({ accountId }: { accountId: string }) {
  const [filters, setFilters] = useState(blankEnquiryReportFilters),
    [shown, setShown] = useState(30),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [message, setMessage] = useState('');
  const parsed = enquiryReportFilters.safeParse(filters),
    cache = useQueryClient(),
    key = ['enquiry-report', accountId, filters];
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  function change(update: Partial<EnquiryReportFilters>) {
    setFilters({ ...filters, ...update });
    setShown(30);
    setMessage('');
    setError(null);
  }
  async function read(signal: AbortSignal) {
    const requested = enquiryReportFilters.parse(filters);
    const result = enquiryReport.parse(
      await api(`/studio/enquiry-report?${new URLSearchParams(requested)}`, {
        signal,
        headers: { [ENQUIRY_REPORT_ACTOR]: accountId },
      }),
    );
    if (
      result.accountId !== accountId ||
      JSON.stringify(result.filters) !== JSON.stringify(requested)
    )
      throw new HttpError(
        403,
        'This report no longer matches the signed-in account or requested filters.',
      );
    return result;
  }
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => read(signal),
    enabled: parsed.success,
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  async function download() {
    if (
      !parsed.success ||
      pending.current ||
      busy ||
      query.isFetching ||
      query.error
    )
      return;
    const controller = new AbortController();
    const assertActive = exportNavigationGuard(controller);
    pending.current = controller;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      const value = await read(controller.signal);
      assertActive();
      cache.setQueryData(key, value);
      saveFile(
        new Blob([enquiryReportCsv(value)], { type: 'text/csv;charset=utf-8' }),
        'picfind-enquiry-report.csv',
      );
      setMessage(
        `${value.rows.length} matching enquiries exported. Contact details ${value.filters.contacts === 'include' ? 'included' : 'omitted'}.`,
      );
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (pending.current === controller) pending.current = null;
    }
  }
  if (
    [error, query.error].some(
      (v) => v instanceof HttpError && [401, 403].includes(v.status),
    )
  )
    return <ErrorNote error={query.error ?? error} />;
  const value = parsed.success && !query.error ? query.data : undefined,
    counts = value ? enquiryReportCounts(value) : null;
  return (
    <section className="enquiry-report stack">
      <PageTitle title="Enquiry report" eyebrow="Private studio" />
      <p>
        Compare retained session requests by received date, stage and session
        type. Counts represent enquiries, not unique people, bookings or
        payments. Deleted requests are excluded.
      </p>
      <Link to="/app/enquiries" className="button secondary">
        Back to enquiry inbox
      </Link>
      <ErrorNote error={query.error} />
      <ErrorNote error={error} />
      {message && <p role="status">{message}</p>}
      <fieldset disabled={busy} className="report-controls">
        <legend>Report filters</legend>
        <label>
          Received from (UTC)
          <input
            type="date"
            value={filters.from}
            onChange={(e) => change({ from: e.target.value })}
          />
        </label>
        <label>
          Received through (UTC)
          <input
            type="date"
            value={filters.to}
            onChange={(e) => change({ to: e.target.value })}
          />
        </label>
        <label>
          Report stage
          <select
            value={filters.stage}
            onChange={(e) =>
              change({ stage: e.target.value as EnquiryReportFilters['stage'] })
            }
          >
            <option value="">All stages</option>
            {enquiryStages.map((stage) => (
              <option value={stage} key={stage}>
                {stage}
              </option>
            ))}
          </select>
        </label>
        <label>
          Session type contains
          <input
            maxLength={100}
            value={filters.session}
            onChange={(e) => change({ session: e.target.value })}
          />
        </label>
        <label className="report-disclosure">
          <input
            type="checkbox"
            checked={filters.contacts === 'include'}
            onChange={(e) =>
              change({ contacts: e.target.checked ? 'include' : 'omit' })
            }
          />
          Include unverified contact details
        </label>
        <p>
          Names, email addresses and phone numbers are omitted by default.
          Messages and private follow-up notes are always excluded.
        </p>
        {!parsed.success && (
          <p role="alert">
            Choose valid dates with the end date on or after the start date.
          </p>
        )}
        <button
          className="button secondary"
          type="button"
          disabled={!parsed.success || query.isFetching}
          onClick={() => {
            setError(null);
            setMessage('');
            void query.refetch();
          }}
        >
          Refresh enquiry report
        </button>
        <button
          className="button primary"
          type="button"
          disabled={!value || query.isFetching}
          onClick={() => void download()}
        >
          Download matching enquiries CSV
        </button>
      </fieldset>
      {query.isPending && parsed.success && <Loading />}
      {value && counts && (
        <section aria-label="Enquiry report results" className="stack">
          <p>
            {value.rows.length} matching enquiries of {value.retainedCount}{' '}
            retained. Checked{' '}
            <time dateTime={value.checkedAt}>
              {new Date(value.checkedAt).toLocaleString()}
            </time>
            .
          </p>
          <div className="report-counts">
            <table>
              <caption>Current stage counts</caption>
              <thead>
                <tr>
                  <th scope="col">Stage</th>
                  <th scope="col">Enquiries</th>
                </tr>
              </thead>
              <tbody>
                {counts.stages.map((row) => (
                  <tr key={row.stage}>
                    <th scope="row">{row.stage}</th>
                    <td>{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table>
              <caption>Session type counts</caption>
              <thead>
                <tr>
                  <th scope="col">Session type as submitted</th>
                  <th scope="col">Enquiries</th>
                </tr>
              </thead>
              <tbody>
                {counts.sessions.map((row) => (
                  <tr key={row.sessionType}>
                    <th scope="row">{row.sessionType}</th>
                    <td>{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!value.rows.length && (
            <p>
              No retained enquiries match these filters. A CSV download will
              contain column headings only.
            </p>
          )}
          <div
            className="report-rows"
            role="region"
            aria-label="Matching enquiry rows"
            tabIndex={0}
          >
            <table>
              <caption>Matching enquiries</caption>
              <thead>
                <tr>
                  <th scope="col">Received UTC</th>
                  <th scope="col">Requested date</th>
                  <th scope="col">Session type</th>
                  <th scope="col">Stage</th>
                  {value.filters.contacts === 'include' && (
                    <th scope="col">Contact details (unverified)</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {value.rows.slice(0, shown).map((row) => (
                  <tr key={row.id}>
                    <td>
                      <time dateTime={row.createdAt}>{row.createdAt}</time>
                    </td>
                    <td>{row.date || 'Not provided'}</td>
                    <td>{row.sessionType}</td>
                    <td>{row.stage}</td>
                    {row.contact && (
                      <td>
                        {row.contact.name}
                        <br />
                        {row.contact.email}
                        <br />
                        {row.contact.phone || 'No phone provided'}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shown < value.rows.length && (
            <button
              type="button"
              className="button secondary"
              onClick={() => setShown(shown + 30)}
            >
              Show more enquiry rows
            </button>
          )}
        </section>
      )}
    </section>
  );
}
