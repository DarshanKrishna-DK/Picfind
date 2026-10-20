import { z } from 'zod';
import { serviceCurrencies, minorToDecimal } from './studio-services.js';

export const EXPENSE_LIMIT = 500;
export const EXPENSE_RECOVERY_LIMIT = 1000;
export const EXPENSE_PAGE_SIZE = 40;
export const EXPENSE_ACTOR = 'X-PicFind-Expense-Actor';
export const expenseCategories = [
  'travel',
  'crew',
  'equipment',
  'venue',
  'software',
  'delivery',
  'other',
] as const;
const line = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .regex(/^[^\p{Cc}]*$/u);
const date = z.iso.date();
const version = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1);
const budget = (limit: number) => (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length <= limit;
const fields = {
  title: line(120).min(1),
  merchant: line(120),
  category: z.enum(expenseCategories),
  incurredOn: date,
  direction: z.enum(['expense', 'refund']),
  currency: z.enum(serviceCurrencies),
  amountMinor: z.number().int().min(1).max(1_000_000_000),
  reference: line(100),
  note: z.string().trim().max(1000),
  projectId: z.uuid().nullable(),
};
export const expenseFields = z.object(fields).strict().refine(budget(5500));
export type ExpenseFields = z.infer<typeof expenseFields>;
export const expenseWrite = z
  .object({
    ...fields,
    generation: z.uuid().nullable(),
    version: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 2),
  })
  .strict()
  .refine((value) => (value.version === 0) === (value.generation === null))
  // Leave room for the server-generated identity and timestamps.
  .refine(budget(5500));
export const savedExpense = z
  .object({
    ...fields,
    id: z.uuid(),
    generation: z.uuid(),
    version,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .refine(budget(6000))
  .refine(
    (value) => Date.parse(value.createdAt) <= Date.parse(value.updatedAt),
  );
export type StudioExpense = z.infer<typeof savedExpense>;
export const expenseDelete = z
  .object({ generation: z.uuid(), version })
  .strict();
const filters = {
  direction: z.enum(['all', 'expense', 'refund']).default('all'),
  category: z.enum(['all', ...expenseCategories]).default('all'),
  from: z.union([date, z.literal('')]).default(''),
  to: z.union([date, z.literal('')]).default(''),
  project: z
    .union([z.uuid(), z.literal('all'), z.literal('none')])
    .default('all'),
  search: z.string().trim().max(200).default(''),
};
const dateOrder = (value: { from: string; to: string }) =>
  !value.from || !value.to || value.from <= value.to;
export const expenseFilter = z.object(filters).strict().refine(dateOrder);
export type ExpenseFilter = z.infer<typeof expenseFilter>;
export const expensePageFilter = z
  .object({
    ...filters,
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .max(EXPENSE_RECOVERY_LIMIT)
      .default(0),
  })
  .strict()
  .refine(dateOrder);
export const expenseView = z
  .object({
    entry: savedExpense,
    projectName: z.string().min(1).max(100).nullable(),
    projectUnavailable: z.boolean(),
  })
  .strict();
export type ExpenseView = z.infer<typeof expenseView>;
const total = z
  .object({
    currency: z.enum(serviceCurrencies),
    expenses: z.number().int().min(0).max(1_000_000_000_000),
    refunds: z.number().int().min(0).max(1_000_000_000_000),
    net: z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000),
  })
  .strict()
  .refine((value) => value.net === value.expenses - value.refunds);
export function expenseTotals(entries: StudioExpense[]) {
  return serviceCurrencies.flatMap((currency) => {
    const matching = entries.filter((row) => row.currency === currency);
    if (!matching.length) return [];
    const expenses = matching
      .filter((row) => row.direction === 'expense')
      .reduce((sum, row) => sum + row.amountMinor, 0);
    const refunds = matching
      .filter((row) => row.direction === 'refund')
      .reduce((sum, row) => sum + row.amountMinor, 0);
    return [
      total.parse({ currency, expenses, refunds, net: expenses - refunds }),
    ];
  });
}
export const expenseJournal = z
  .object({
    accountId: z.string().min(1),
    limit: z.literal(EXPENSE_LIMIT),
    pageSize: z.literal(EXPENSE_PAGE_SIZE),
    offset: z.number().int().min(0),
    totalCount: z.number().int().min(0).max(EXPENSE_RECOVERY_LIMIT),
    filteredCount: z.number().int().min(0).max(EXPENSE_RECOVERY_LIMIT),
    entries: z.array(expenseView).max(EXPENSE_PAGE_SIZE),
    totals: z.array(total).max(4),
    projects: z
      .array(
        z.object({ id: z.uuid(), name: z.string().min(1).max(100) }).strict(),
      )
      .max(500),
  })
  .strict()
  .refine(
    (value) =>
      value.filteredCount <= value.totalCount &&
      value.entries.length <= value.filteredCount,
  );
export const expenseExport = z
  .object({
    accountId: z.string().min(1),
    entries: z.array(expenseView).max(EXPENSE_RECOVERY_LIMIT),
    generatedAt: z.iso.datetime(),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.entries.map((row) => row.entry.id)).size ===
      value.entries.length,
  );
export const blankExpense = (): ExpenseFields => ({
  title: '',
  merchant: '',
  category: 'other',
  incurredOn: '',
  direction: 'expense',
  currency: 'INR',
  amountMinor: 1,
  reference: '',
  note: '',
  projectId: null,
});
export function expenseCsv(entries: ExpenseView[]) {
  const values = expenseExport.parse({
    accountId: 'export',
    entries,
    generatedAt: new Date().toISOString(),
  }).entries;
  const cell = (value: string | number) => {
    const text = String(value);
    return `"${(/^\s*[=+\-@]/u.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`;
  };
  return (
    '\ufeff' +
    [
      [
        'ID',
        'Date',
        'Direction',
        'Title',
        'Merchant',
        'Category',
        'Currency',
        'Amount',
        'Amount minor units',
        'Project ID',
        'Project',
        'Reference',
        'Note',
        'Version',
      ],
      ...values.map(({ entry, projectName, projectUnavailable }) => [
        entry.id,
        entry.incurredOn,
        entry.direction,
        entry.title,
        entry.merchant,
        entry.category,
        entry.currency,
        minorToDecimal(entry.amountMinor),
        entry.amountMinor,
        entry.projectId ?? '',
        projectUnavailable ? 'Unavailable project' : (projectName ?? ''),
        entry.reference,
        entry.note,
        entry.version,
      ]),
    ]
      .map((row) => row.map(cell).join(','))
      .join('\r\n') +
    '\r\n'
  );
}
