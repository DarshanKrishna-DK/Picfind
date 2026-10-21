import { z } from 'zod';
import {
  enquiryStage,
  enquiryStages,
  savedEnquiry,
  type Enquiry,
} from './studio-enquiries.js';
export const ENQUIRY_REPORT_ACTOR = 'X-PicFind-Enquiry-Report-Actor';
export const ENQUIRY_REPORT_LIMIT = 500;
const optionalDate = z.union([z.iso.date(), z.literal('')]);
export const enquiryReportFilters = z
  .object({
    from: optionalDate,
    to: optionalDate,
    stage: z.union([enquiryStage, z.literal('')]),
    session: z.string().trim().max(100),
    contacts: z.enum(['omit', 'include']),
  })
  .strict()
  .refine(
    (v) => !v.from || !v.to || v.from <= v.to,
    'The received end date must be on or after the start date.',
  );
export type EnquiryReportFilters = z.infer<typeof enquiryReportFilters>;
export const blankEnquiryReportFilters = (): EnquiryReportFilters => ({
  from: '',
  to: '',
  stage: '',
  session: '',
  contacts: 'omit',
});
const reportRow = z
  .object({
    id: z.uuid(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    date: optionalDate,
    sessionType: z.string().min(1).max(100),
    stage: enquiryStage,
    contact: z
      .object({
        name: z.string().min(1).max(100),
        email: z.email().max(254),
        phone: z.string().max(40),
      })
      .strict()
      .optional(),
  })
  .strict();
export const enquiryReport = z
  .object({
    accountId: z.string().min(1),
    checkedAt: z.iso.datetime(),
    filters: enquiryReportFilters,
    retainedCount: z.number().int().min(0).max(ENQUIRY_REPORT_LIMIT),
    rows: z.array(reportRow).max(ENQUIRY_REPORT_LIMIT),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.rows.length > value.retainedCount ||
      new Set(value.rows.map((row) => row.id)).size !== value.rows.length ||
      value.rows.some(
        (row) =>
          (value.filters.contacts === 'include') !==
            (row.contact !== undefined) ||
          Date.parse(row.createdAt) > Date.parse(row.updatedAt) ||
          !matches(row, value.filters),
      )
    )
      context.addIssue({
        code: 'custom',
        message:
          'The enquiry report does not match its filters, count or disclosure mode.',
      });
  });
export type EnquiryReport = z.infer<typeof enquiryReport>;
function matches(
  row: z.infer<typeof reportRow>,
  filters: EnquiryReportFilters,
) {
  const day = row.createdAt.slice(0, 10);
  return (
    (!filters.from || day >= filters.from) &&
    (!filters.to || day <= filters.to) &&
    (!filters.stage || row.stage === filters.stage) &&
    row.sessionType.toLowerCase().includes(filters.session.toLowerCase())
  );
}
export function buildEnquiryReport(
  accountId: string,
  checkedAt: string,
  input: Enquiry[],
  rawFilters: EnquiryReportFilters,
) {
  const filters = enquiryReportFilters.parse(rawFilters);
  const entries = z.array(savedEnquiry).max(ENQUIRY_REPORT_LIMIT).parse(input);
  if (new Set(entries.map((row) => row.id)).size !== entries.length)
    throw new Error('Duplicate enquiry identities.');
  const rows = entries
    .filter((row) => matches(row, filters))
    .sort(
      (a, b) =>
        Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
        a.id.localeCompare(b.id),
    )
    .map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      date: row.date,
      sessionType: row.sessionType,
      stage: row.stage,
      ...(filters.contacts === 'include'
        ? { contact: { name: row.name, email: row.email, phone: row.phone } }
        : {}),
    }));
  return enquiryReport.parse({
    accountId,
    checkedAt,
    filters,
    retainedCount: entries.length,
    rows,
  });
}
export function enquiryReportCounts(report: EnquiryReport) {
  const value = enquiryReport.parse(report),
    sessions = new Map<string, number>();
  for (const row of value.rows)
    sessions.set(row.sessionType, (sessions.get(row.sessionType) ?? 0) + 1);
  return {
    stages: enquiryStages.map((stage) => ({
      stage,
      count: value.rows.filter((row) => row.stage === stage).length,
    })),
    sessions: [...sessions]
      .map(([sessionType, count]) => ({ sessionType, count }))
      .sort(
        (a, b) =>
          b.count - a.count || a.sessionType.localeCompare(b.sessionType),
      ),
  };
}
export function enquiryReportCsv(input: unknown) {
  const value = enquiryReport.parse(input);
  const cell = (value: string) => {
    const safe = /^\s*[=+\-@]/u.test(value) ? `'${value}` : value;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const header = [
    'Enquiry ID',
    'Received UTC',
    'Updated UTC',
    'Requested session date',
    'Session type',
    'Stage',
    ...(value.filters.contacts === 'include'
      ? ['Name (unverified)', 'Email (unverified)', 'Phone (unverified)']
      : []),
  ];
  const rows = value.rows.map((row) => [
    row.id,
    row.createdAt,
    row.updatedAt,
    row.date,
    row.sessionType,
    row.stage,
    ...(row.contact
      ? [row.contact.name, row.contact.email, row.contact.phone]
      : []),
  ]);
  const content =
    '\ufeff' +
    [header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') +
    '\r\n';
  if (new TextEncoder().encode(content).length > 1_000_000)
    throw new Error('This report exceeds the CSV size limit.');
  return content;
}
