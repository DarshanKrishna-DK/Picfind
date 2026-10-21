import { z } from 'zod';

export const ENQUIRY_LIMIT = 200;
export const ENQUIRY_HOURLY_LIMIT = 25;
export const ENQUIRY_PAGE_SIZE = 50;
export const ENQUIRY_CONSENT = 'studio-enquiry-v1';
export const ENQUIRY_ACTOR = 'X-PicFind-Enquiry-Actor';
export const enquiryStages = [
  'new',
  'contacted',
  'qualified',
  'closed',
] as const;
const version = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1);
const writeVersion = version.max(Number.MAX_SAFE_INTEGER - 2);
const line = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .regex(/^[^\p{Cc}]*$/u);
export const enquiryFormFields = z
  .object({
    name: line(100).min(1),
    introduction: z.string().trim().max(1000),
    enabled: z.boolean(),
  })
  .strict();
export const enquiryFormWrite = enquiryFormFields
  .extend({
    version: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 2),
  })
  .strict();
export const savedEnquiryForm = enquiryFormFields
  .extend({
    id: z.uuid(),
    version,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .refine((row) => Date.parse(row.createdAt) <= Date.parse(row.updatedAt));
export type EnquiryForm = z.infer<typeof savedEnquiryForm>;
export const enquiryFormDirectory = z
  .object({
    accountId: z.string().min(1),
    id: z.uuid(),
    form: savedEnquiryForm.nullable(),
  })
  .strict()
  .refine((data) => !data.form || data.form.id === data.id);
export const publishedEnquiryForm = z
  .object({
    id: z.uuid(),
    name: line(100).min(1),
    introduction: z.string().max(1000),
    version,
  })
  .strict();
const enquiryFields = z
  .object({
    name: line(100).min(1),
    email: z
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    phone: line(40),
    date: z.union([z.iso.date(), z.literal('')]),
    sessionType: line(100).min(1),
    message: z.string().trim().min(1).max(2000),
  })
  .strict();
export type EnquiryFields = z.infer<typeof enquiryFields>;
export const enquirySubmit = enquiryFields
  .extend({
    formVersion: version,
    consent: z.literal(ENQUIRY_CONSENT),
  })
  .strict()
  .refine(
    (row) => new TextEncoder().encode(JSON.stringify(row)).length <= 6000,
  );
export const enquiryStage = z.enum(enquiryStages);
export const enquiryUpdate = z
  .object({
    version: writeVersion,
    stage: enquiryStage,
    note: z.string().trim().max(1000),
  })
  .strict();
export const savedEnquiry = enquiryFields
  .extend({
    id: z.uuid(),
    formId: z.uuid(),
    formVersion: version,
    consent: z.literal(ENQUIRY_CONSENT),
    version,
    stage: enquiryStage,
    note: z.string().max(1000),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    history: z
      .array(
        z
          .object({
            stage: enquiryStage,
            at: z.iso.datetime(),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict()
  .refine(
    (row) =>
      Date.parse(row.createdAt) <= Date.parse(row.updatedAt) &&
      row.history[0]?.stage === 'new' &&
      row.history[0]?.at === row.createdAt &&
      row.history.at(-1)?.stage === row.stage &&
      row.history.every(
        (entry, i) =>
          Date.parse(entry.at) <= Date.parse(row.updatedAt) &&
          (i === 0 ||
            (Date.parse(entry.at) >= Date.parse(row.history[i - 1]!.at) &&
              entry.stage !== row.history[i - 1]!.stage)),
      ),
  );
export type Enquiry = z.infer<typeof savedEnquiry>;
export const enquiryReceipt = z
  .object({ id: z.uuid(), receivedAt: z.iso.datetime() })
  .strict();
export const enquiryInbox = z
  .object({
    accountId: z.string().min(1),
    limit: z.literal(ENQUIRY_LIMIT),
    pageSize: z.literal(ENQUIRY_PAGE_SIZE),
    offset: z.number().int().min(0),
    totalCount: z.number().int().min(0),
    filteredCount: z.number().int().min(0),
    enquiries: z.array(savedEnquiry).max(ENQUIRY_PAGE_SIZE),
  })
  .strict()
  .refine(
    (data) =>
      data.filteredCount <= data.totalCount &&
      data.enquiries.length <= data.filteredCount &&
      new Set(data.enquiries.map((row) => row.id)).size ===
        data.enquiries.length,
  );
export const blankEnquiry = (): EnquiryFields => ({
  name: '',
  email: '',
  phone: '',
  date: '',
  sessionType: '',
  message: '',
});
