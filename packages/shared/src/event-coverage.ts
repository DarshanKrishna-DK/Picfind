import { z } from 'zod';

export const COVERAGE_CATEGORY_LIMIT = 20;
export const COVERAGE_REFERENCE_LIMIT = 100;
export const coverageCategory = z
  .object({
    id: z.uuid(),
    label: z.string().trim().min(1).max(80),
    target: z.number().int().min(1).max(50),
    note: z.string().trim().max(200),
    photoIds: z.array(z.uuid()).max(50),
  })
  .strict()
  .refine((row) => new Set(row.photoIds).size === row.photoIds.length);
export type CoverageCategory = z.infer<typeof coverageCategory>;
export const coverageItems = z
  .array(coverageCategory)
  .max(COVERAGE_CATEGORY_LIMIT)
  .refine(
    (rows) =>
      new Set(rows.map((row) => row.id)).size === rows.length &&
      new Set(rows.map((row) => row.label.toLowerCase())).size ===
        rows.length &&
      rows.reduce((total, row) => total + row.photoIds.length, 0) <=
        COVERAGE_REFERENCE_LIMIT &&
      new TextEncoder().encode(JSON.stringify(rows)).byteLength <= 12_000,
  );
export const coverageWrite = z
  .object({
    version: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 2),
    items: coverageItems,
  })
  .strict();
export const storedCoverage = z
  .object({
    version: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 1),
    updatedAt: z.iso.datetime(),
    items: coverageItems,
  })
  .strict();
export type StoredCoverage = z.infer<typeof storedCoverage>;
export const coverageDraft = z
  .object({
    version: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    updatedAt: z.iso.datetime().nullable(),
    items: coverageItems,
  })
  .strict()
  .refine((value) =>
    value.version === 0
      ? value.updatedAt === null && value.items.length === 0
      : value.updatedAt !== null,
  );
export type CoveragePlan = z.infer<typeof coverageDraft>;
export const emptyCoverage = (): CoveragePlan => ({
  version: 0,
  updatedAt: null,
  items: [],
});
export function coveragePhotoIds(items: readonly CoverageCategory[]) {
  return [...new Set(items.flatMap((row) => row.photoIds))];
}
export function newCoverageAssignments(
  current: readonly CoverageCategory[],
  next: readonly CoverageCategory[],
) {
  const previous = new Map(
    current.map((row) => [row.id, new Set(row.photoIds)]),
  );
  return [
    ...new Set(
      next.flatMap((row) =>
        row.photoIds.filter((id) => !previous.get(row.id)?.has(id)),
      ),
    ),
  ];
}
export const coverageSnapshot = z
  .object({
    accountId: z.string().min(1),
    eventId: z.uuid(),
    editable: z.boolean(),
    plan: coverageDraft,
    availableIds: z.array(z.uuid()).max(COVERAGE_REFERENCE_LIMIT),
  })
  .strict()
  .refine((value) => {
    const assigned = new Set(coveragePhotoIds(value.plan.items));
    return (
      new Set(value.availableIds).size === value.availableIds.length &&
      value.availableIds.every((id) => assigned.has(id))
    );
  });
export type CoverageSnapshot = z.infer<typeof coverageSnapshot>;
export function coverageStatus(
  category: CoverageCategory,
  available: ReadonlySet<string>,
) {
  const count = category.photoIds.filter((id) => available.has(id)).length;
  return {
    count,
    remaining: Math.max(0, category.target - count),
    unavailable: category.photoIds.length - count,
    status:
      count === 0
        ? ('missing' as const)
        : count < category.target
          ? ('partial' as const)
          : ('target-met' as const),
  };
}
