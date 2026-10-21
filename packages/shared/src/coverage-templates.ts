import { z } from 'zod';
import { coverageItems, type CoverageCategory } from './event-coverage.js';

export const COVERAGE_TEMPLATE_LIMIT = 30;
export const COVERAGE_TEMPLATE_RECOVERY_LIMIT = 100;
export const TEMPLATE_ACTOR = 'X-PicFind-Coverage-Template-Actor';
const line = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .regex(/^[^\p{Cc}]*$/u);
const category = z
  .object({
    label: line(80).min(1),
    target: z.number().int().min(1).max(50),
    note: line(200),
  })
  .strict();
export const templateFields = z
  .object({
    title: line(80).min(1),
    categories: z
      .array(category)
      .min(1)
      .max(20)
      .refine(
        (rows) =>
          new Set(rows.map((row) => row.label.toLowerCase())).size ===
          rows.length,
      ),
  })
  .strict()
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 10000,
  );
export type TemplateFields = z.infer<typeof templateFields>;
const revision = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1);
export const templateWrite = z
  .object({
    fields: templateFields,
    generation: z.uuid().nullable(),
    version: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 2),
  })
  .strict()
  .refine((value) => (value.version === 0) === (value.generation === null));
export const templateDelete = z
  .object({ generation: z.uuid(), version: revision })
  .strict();
export const savedTemplate = z
  .object({
    id: z.uuid(),
    generation: z.uuid(),
    version: revision,
    fields: templateFields,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .refine(
    (value) => Date.parse(value.createdAt) <= Date.parse(value.updatedAt),
  );
export type SavedTemplate = z.infer<typeof savedTemplate>;
export const templateDirectory = z
  .object({
    accountId: z.string().min(1),
    limit: z.literal(COVERAGE_TEMPLATE_LIMIT),
    templates: z.array(savedTemplate).max(COVERAGE_TEMPLATE_RECOVERY_LIMIT),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.templates.map((row) => row.id)).size ===
      value.templates.length,
  );
export const templateResult = z
  .object({ accountId: z.string().min(1), template: savedTemplate })
  .strict();
export function templateFromCoverage(
  title: string,
  items: readonly CoverageCategory[],
) {
  return templateFields.parse({
    title,
    categories: items.map(({ label, target, note }) => ({
      label,
      target,
      note,
    })),
  });
}
export function applyCoverageTemplate(
  current: CoverageCategory[],
  fields: TemplateFields,
  mode: 'append' | 'replace',
  id: () => string,
) {
  const template = templateFields.parse(fields);
  return coverageItems.parse([
    ...(mode === 'append' ? current : []),
    ...template.categories.map((row) => ({ ...row, id: id(), photoIds: [] })),
  ]);
}
