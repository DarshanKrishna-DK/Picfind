import { z } from 'zod';
import { projectStage } from './studio-projects.js';

export const MILESTONE_LIMIT = 300;
export const PROJECT_MILESTONE_LIMIT = 30;
export const milestoneFields = z
  .object({
    projectId: z.uuid(),
    title: z.string().trim().min(1).max(120),
    note: z.string().trim().max(1000),
    dueDate: z.iso.date(),
    timeZone: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return !/^[+-]/.test(value);
        } catch {
          return false;
        }
      }, 'Choose an IANA timezone such as Asia/Kolkata.'),
    status: z.enum(['open', 'completed']),
  })
  .strict();
export type MilestoneFields = z.infer<typeof milestoneFields>;
export const milestoneWrite = milestoneFields
  .extend({
    version: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
  })
  .strict();
export const savedMilestone = milestoneFields
  .extend({
    id: z.uuid(),
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.createdAt <= value.updatedAt &&
      (value.status === 'open'
        ? value.completedAt === null
        : value.completedAt !== null &&
          value.completedAt >= value.createdAt &&
          value.completedAt <= value.updatedAt),
  );
export type SavedMilestone = z.infer<typeof savedMilestone>;
const projectSummary = z
  .object({
    id: z.uuid(),
    name: z.string().min(1).max(100),
    stage: projectStage,
  })
  .strict();
export const milestoneView = z
  .object({
    milestone: savedMilestone,
    project: projectSummary.nullable(),
  })
  .strict()
  .refine(
    (value) => !value.project || value.project.id === value.milestone.projectId,
  );
export type MilestoneView = z.infer<typeof milestoneView>;
export const workQueue = z
  .object({
    accountId: z.string().min(1),
    limit: z.literal(MILESTONE_LIMIT),
    totalCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    milestones: z.array(milestoneView).max(MILESTONE_LIMIT),
    projects: z
      .array(projectSummary.refine((value) => value.stage !== 'archived'))
      .max(200),
  })
  .strict()
  .refine(
    (value) =>
      value.milestones.length === Math.min(value.totalCount, value.limit) &&
      new Set(value.milestones.map((entry) => entry.milestone.id)).size ===
        value.milestones.length &&
      new Set(value.projects.map((entry) => entry.id)).size ===
        value.projects.length,
  );
export type WorkQueue = z.infer<typeof workQueue>;

export function dateInZone(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (name: string) =>
    parts.find((entry) => entry.type === name)!.value;
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
}
export function isMilestoneOverdue(view: MilestoneView, now: Date) {
  return (
    !!view.project &&
    view.project.stage !== 'archived' &&
    view.milestone.status === 'open' &&
    dateInZone(now, view.milestone.timeZone) > view.milestone.dueDate
  );
}
export function advanceMilestone(
  current: SavedMilestone | null,
  id: string,
  fields: MilestoneFields,
  now: string,
): SavedMilestone {
  return savedMilestone.parse({
    ...fields,
    id,
    version: (current?.version ?? 0) + 1,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
    completedAt:
      fields.status === 'open' ? null : (current?.completedAt ?? now),
  });
}
