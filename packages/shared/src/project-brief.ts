import { z } from 'zod';
import { projectStage } from './studio-projects.js';
import { appointmentZone } from './studio-appointments.js';

export const BRIEF_ACTOR = 'X-PicFind-Brief-Actor';
export const briefNoteMode = z.enum(['omit', 'include']);
export type BriefNoteMode = z.infer<typeof briefNoteMode>;
const identity = { id: z.uuid(), title: z.string().min(1).max(200) };
export const projectBrief = z
  .object({
    accountId: z.string().min(1),
    checkedAt: z.iso.datetime(),
    notes: briefNoteMode,
    project: z
      .object({
        id: z.uuid(),
        createdAt: z.iso.datetime(),
        version: z.number().int().positive(),
        name: z.string().min(1).max(100),
        stage: projectStage,
        summary: z.string().max(1000).optional(),
      })
      .strict(),
    events: z
      .array(
        z
          .object({
            id: z.uuid(),
            title: z.string().min(1).max(200).nullable(),
          })
          .strict(),
      )
      .max(20),
    milestones: z
      .array(
        z
          .object({
            ...identity,
            dueDate: z.iso.date(),
            timeZone: appointmentZone,
            status: z.enum(['open', 'completed']),
            note: z.string().max(1000).optional(),
          })
          .strict(),
      )
      .max(30),
    appointments: z
      .array(
        z
          .object({
            ...identity,
            startAt: z.iso.datetime(),
            endAt: z.iso.datetime(),
            timeZone: appointmentZone,
            status: z.enum(['scheduled', 'cancelled']),
            note: z.string().max(1000).optional(),
          })
          .strict()
          .refine((v) => Date.parse(v.endAt) > Date.parse(v.startAt)),
      )
      .max(30),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      [v.events, v.milestones, v.appointments].some(
        (rows) => new Set(rows.map((row) => row.id)).size !== rows.length,
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Brief identities must be unique within each section.',
      });
    const notes = [
      v.project.summary,
      ...v.milestones.map((row) => row.note),
      ...v.appointments.map((row) => row.note),
    ];
    if (
      notes.some((note) =>
        v.notes === 'omit' ? note !== undefined : note === undefined,
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Brief notes do not match the selected disclosure mode.',
      });
  });
export type ProjectBrief = z.infer<typeof projectBrief>;
export function exportProjectBrief(input: unknown, format: 'text' | 'json') {
  const value = projectBrief.parse(input);
  if (format !== 'text' && format !== 'json')
    throw new Error('Choose a supported brief format.');
  const content =
    format === 'json'
      ? JSON.stringify(
          {
            format: 'picfind-project-brief',
            formatVersion: 1,
            ...value,
          },
          null,
          2,
        ) + '\n'
      : [
          'PICFIND PRIVATE PROJECT PRODUCTION BRIEF',
          `Project: ${value.project.name}`,
          `Project ID: ${value.project.id}`,
          `Project created: ${value.project.createdAt}`,
          `Stage: ${value.project.stage}`,
          `Checked: ${value.checkedAt}`,
          `Private notes: ${value.notes === 'include' ? 'included' : 'omitted'}`,
          'Local copy only. Review current records in PicFind before relying on this plan.',
          ...(value.project.summary !== undefined
            ? ['', 'PROJECT SUMMARY', value.project.summary]
            : []),
          '',
          `LINKED EVENTS (${value.events.length})`,
          ...value.events.map(
            (row) => `${row.title ?? 'Unavailable linked event'} [${row.id}]`,
          ),
          '',
          `MILESTONES (${value.milestones.length})`,
          ...value.milestones.flatMap((row) => [
            `${row.dueDate} (${row.timeZone}) | ${row.status} | ${row.title} [${row.id}]`,
            ...(row.note !== undefined ? [`Note: ${row.note}`] : []),
          ]),
          '',
          `APPOINTMENTS (${value.appointments.length})`,
          ...value.appointments.flatMap((row) => [
            `${row.startAt} to ${row.endAt} | ${row.timeZone} | ${row.status} | ${row.title} [${row.id}]`,
            ...(row.note !== undefined ? [`Note: ${row.note}`] : []),
          ]),
          '',
        ].join('\n');
  if (new TextEncoder().encode(content).length > 500_000)
    throw new Error('The brief exceeds the download size limit.');
  return {
    content,
    type:
      format === 'json'
        ? 'application/json;charset=utf-8'
        : 'text/plain;charset=utf-8',
    filename: `picfind-project-${value.project.id}-brief.${format === 'json' ? 'json' : 'txt'}`,
  };
}
