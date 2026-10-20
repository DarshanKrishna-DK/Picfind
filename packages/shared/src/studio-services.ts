import { z } from 'zod';

export const SERVICE_LIMIT = 200;
export const SERVICE_PAGE_SIZE = 40;
export const SERVICE_ACTOR = 'X-PicFind-Service-Actor';
export const serviceCurrencies = ['INR', 'USD', 'EUR', 'GBP'] as const;
export const serviceModes = ['fixed', 'starting', 'quote'] as const;
const line = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .regex(/^[^\p{Cc}]*$/u);
const version = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 2);
const fields = {
  title: line(100).min(1),
  description: z.string().trim().max(2000),
  deliverables: z.array(line(200).min(1)).max(20),
  durationMinutes: z.number().int().min(1).max(1440).nullable(),
  pricingMode: z.enum(serviceModes),
  currency: z.enum(serviceCurrencies),
  amountMinor: z.number().int().min(0).max(1_000_000_000).nullable(),
  archived: z.boolean(),
};
type Price = {
  pricingMode: (typeof serviceModes)[number];
  amountMinor: number | null;
};
const priceValid = (value: Price) =>
  value.pricingMode === 'quote'
    ? value.amountMinor === null
    : value.amountMinor !== null;
const budgetValid = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length <= 7000;
const savedBudgetValid = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length <= 8000;
export const serviceFields = z
  .object(fields)
  .strict()
  .refine(priceValid)
  .refine(budgetValid);
export type ServiceFields = z.infer<typeof serviceFields>;
export const serviceWrite = z
  .object({ ...fields, version })
  .strict()
  .refine(priceValid)
  .refine(budgetValid);
export const savedService = z
  .object({
    ...fields,
    id: z.uuid(),
    version: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .refine(priceValid)
  .refine(savedBudgetValid)
  .refine(
    (value) => Date.parse(value.createdAt) <= Date.parse(value.updatedAt),
  );
export type StudioService = z.infer<typeof savedService>;
export const serviceFilter = z
  .object({
    state: z.enum(['active', 'archived', 'all']).default('active'),
    search: z.string().trim().max(200).default(''),
  })
  .strict();
export const servicePageFilter = serviceFilter
  .extend({
    offset: z.coerce.number().int().min(0).max(500).default(0),
  })
  .strict();
export const serviceCatalog = z
  .object({
    accountId: z.string().min(1),
    limit: z.literal(SERVICE_LIMIT),
    pageSize: z.literal(SERVICE_PAGE_SIZE),
    offset: z.number().int().min(0),
    totalCount: z.number().int().min(0),
    filteredCount: z.number().int().min(0),
    services: z.array(savedService).max(SERVICE_PAGE_SIZE),
  })
  .strict()
  .refine(
    (value) =>
      value.filteredCount <= value.totalCount &&
      value.services.length <= value.filteredCount &&
      new Set(value.services.map((row) => row.id)).size ===
        value.services.length,
  );
export const serviceExport = z
  .object({
    accountId: z.string().min(1),
    services: z.array(savedService).max(500),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.services.map((row) => row.id)).size ===
      value.services.length,
  );
export const blankService = (): ServiceFields => ({
  title: '',
  description: '',
  deliverables: [],
  durationMinutes: null,
  pricingMode: 'quote',
  currency: 'INR',
  amountMinor: null,
  archived: false,
});
export function decimalToMinor(text: string): number | null {
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(text.trim())) return null;
  const [whole, fraction = ''] = text.trim().split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return amount <= 1_000_000_000 ? amount : null;
}
export function minorToDecimal(value: number | null) {
  return value === null
    ? ''
    : `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
}
export function servicePrice(value: ServiceFields) {
  if (value.pricingMode === 'quote') return 'Request a quote';
  const amount = new Intl.NumberFormat('en', {
    style: 'currency',
    currency: value.currency,
  }).format(value.amountMinor! / 100);
  return value.pricingMode === 'starting' ? `Starting at ${amount}` : amount;
}
export function serviceCsv(values: StudioService[]) {
  const rows = z.array(savedService).max(500).parse(values);
  const cell = (input: string | number) => {
    const value = String(input),
      safe = /^\s*[=+\-@]/u.test(value) ? `'${value}` : value;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return (
    '\uFEFF' +
    [
      [
        'Service ID',
        'Title',
        'Description',
        'Deliverables',
        'Duration minutes',
        'Pricing mode',
        'Currency',
        'Amount minor units',
        'Archived',
        'Version',
      ],
      ...rows.map((row) => [
        row.id,
        row.title,
        row.description,
        row.deliverables.join('\n'),
        row.durationMinutes ?? '',
        row.pricingMode,
        row.currency,
        row.amountMinor ?? '',
        row.archived ? 'yes' : 'no',
        row.version,
      ]),
    ]
      .map((row) => row.map(cell).join(','))
      .join('\r\n') +
    '\r\n'
  );
}
