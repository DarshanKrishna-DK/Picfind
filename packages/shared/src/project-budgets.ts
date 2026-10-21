import { z } from 'zod';
import { serviceCurrencies } from './studio-services.js';
import { expenseTotals, type StudioExpense } from './studio-expenses.js';

export const BUDGET_ACTOR = 'X-PicFind-Budget-Actor';
const revision = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 2);
const limit = z
  .object({
    currency: z.enum(serviceCurrencies),
    amountMinor: z.number().int().min(0).max(1_000_000_000),
  })
  .strict();
export const budgetFields = z
  .object({
    limits: z
      .array(limit)
      .max(4)
      .refine(
        (rows) => new Set(rows.map((row) => row.currency)).size === rows.length,
      ),
    note: z.string().trim().max(1000),
  })
  .strict()
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 5000,
  );
export type BudgetFields = z.infer<typeof budgetFields>;
export const budgetCommand = z
  .object({
    projectCreatedAt: z.iso.datetime(),
    version: revision,
    fields: budgetFields,
  })
  .strict();
export const savedBudget = z
  .object({
    projectId: z.uuid(),
    projectCreatedAt: z.iso.datetime(),
    version: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 1),
    fields: budgetFields,
    updatedAt: z.iso.datetime(),
    commandDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type SavedBudget = z.infer<typeof savedBudget>;
export function budgetComparison(
  fields: BudgetFields,
  entries: StudioExpense[],
) {
  const totals = expenseTotals(entries);
  return serviceCurrencies.flatMap((currency) => {
    const planned = fields.limits.find((row) => row.currency === currency);
    const total = totals.find((row) => row.currency === currency);
    if (!planned && !total) return [];
    const expenses = total?.expenses ?? 0,
      refunds = total?.refunds ?? 0,
      net = expenses - refunds;
    return [
      {
        currency,
        budget: planned?.amountMinor ?? null,
        expenses,
        refunds,
        net,
        remaining: planned ? planned.amountMinor - net : null,
        overBudget: planned ? Math.max(0, net - planned.amountMinor) : null,
      },
    ];
  });
}
const amount = z.number().int().min(-1_000_000_000_000).max(1_001_000_000_000);
export const budgetReport = z
  .object({
    accountId: z.string().min(1),
    projectId: z.uuid(),
    projectCreatedAt: z.iso.datetime(),
    projectName: z.string().min(1).max(100),
    version: revision.or(z.literal(Number.MAX_SAFE_INTEGER - 1)),
    fields: budgetFields,
    updatedAt: z.iso.datetime().nullable(),
    checkedAt: z.iso.datetime(),
    verifiedEntries: z.number().int().min(0).max(1000),
    unverifiedLinks: z.number().int().min(0).max(1000),
    historicalLinks: z.number().int().min(0).max(1000),
    currencies: z
      .array(
        z
          .object({
            currency: z.enum(serviceCurrencies),
            budget: z.number().int().min(0).max(1_000_000_000).nullable(),
            expenses: z.number().int().min(0).max(1_000_000_000_000),
            refunds: z.number().int().min(0).max(1_000_000_000_000),
            net: amount,
            remaining: amount.nullable(),
            overBudget: amount.nullable(),
          })
          .strict()
          .refine(
            (row) =>
              row.net === row.expenses - row.refunds &&
              (row.budget === null
                ? row.remaining === null && row.overBudget === null
                : row.remaining === row.budget - row.net &&
                  row.overBudget === Math.max(0, row.net - row.budget)),
          ),
      )
      .max(4),
  })
  .strict()
  .refine(
    (report) =>
      new Set(report.currencies.map((row) => row.currency)).size ===
        report.currencies.length &&
      report.verifiedEntries +
        report.unverifiedLinks +
        report.historicalLinks <=
        1000 &&
      report.fields.limits.every((limit) =>
        report.currencies.some(
          (row) =>
            row.currency === limit.currency && row.budget === limit.amountMinor,
        ),
      ) &&
      report.currencies.every(
        (row) =>
          row.budget ===
          (report.fields.limits.find((limit) => limit.currency === row.currency)
            ?.amountMinor ?? null),
      ) &&
      (report.version === 0
        ? report.updatedAt === null &&
          report.fields.limits.length === 0 &&
          report.fields.note === ''
        : report.updatedAt !== null),
  );
export type BudgetReport = z.infer<typeof budgetReport>;
