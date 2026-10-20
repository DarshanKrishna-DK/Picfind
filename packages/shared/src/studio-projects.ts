import { z } from 'zod';

export const PROJECT_LIMIT = 200;
export const PROJECT_STAGES = [
  'inquiry',
  'booked',
  'shooting',
  'editing',
  'proofing',
  'delivered',
  'archived',
] as const;
export const projectStage = z.enum(PROJECT_STAGES);
export const projectFields = z
  .object({
    name: z.string().trim().min(1).max(100),
    summary: z.string().trim().max(1000),
    clientId: z.uuid().nullable(),
    eventIds: z
      .array(z.uuid())
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length),
    stage: projectStage,
  })
  .strict();
export type ProjectFields = z.infer<typeof projectFields>;
export const projectWrite = projectFields
  .extend({
    version: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    reason: z.string().trim().max(160),
  })
  .strict();
const transition = z
  .object({
    sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    from: projectStage.nullable(),
    to: projectStage,
    actorId: z.string().min(1).max(128),
    at: z.iso.datetime(),
    reason: z.string().max(160),
  })
  .strict();
export const savedProject = projectFields
  .extend({
    id: z.uuid(),
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    transitionCount: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    transitions: z.array(transition).min(1).max(30),
  })
  .strict()
  .superRefine((value, context) => {
    const last = value.transitions.at(-1)!;
    if (
      last.to !== value.stage ||
      value.transitionCount > value.version ||
      Date.parse(value.createdAt) > Date.parse(value.updatedAt) ||
      value.transitions.some(
        (entry, index) =>
          entry.sequence !==
            value.transitionCount - value.transitions.length + index + 1 ||
          (entry.sequence === 1 ? entry.from !== null : entry.from === null) ||
          entry.from === entry.to ||
          Date.parse(entry.at) < Date.parse(value.createdAt) ||
          Date.parse(entry.at) > Date.parse(value.updatedAt) ||
          (index > 0 &&
            (entry.from !== value.transitions[index - 1]!.to ||
              Date.parse(entry.at) <
                Date.parse(value.transitions[index - 1]!.at))),
      )
    )
      context.addIssue({
        code: 'custom',
        message: 'Project stage history is inconsistent.',
      });
  });
export type SavedProject = z.infer<typeof savedProject>;
export const projectView = z
  .object({
    project: savedProject,
    client: z
      .object({ id: z.uuid(), name: z.string().max(100).nullable() })
      .strict()
      .nullable(),
    events: z
      .array(
        z
          .object({ id: z.uuid(), title: z.string().max(200).nullable() })
          .strict(),
      )
      .max(20),
  })
  .strict()
  .refine(
    (view) =>
      view.client?.id === (view.project.clientId ?? undefined) &&
      JSON.stringify(view.events.map((event) => event.id)) ===
        JSON.stringify(view.project.eventIds),
  );
export type ProjectView = z.infer<typeof projectView>;
export const projectDirectory = z
  .object({
    accountId: z.string().min(1),
    limit: z.literal(PROJECT_LIMIT),
    totalCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    projects: z.array(projectView).max(PROJECT_LIMIT),
    clients: z
      .array(z.object({ id: z.uuid(), name: z.string().max(100) }).strict())
      .max(200),
    events: z
      .array(z.object({ id: z.uuid(), title: z.string().max(200) }).strict())
      .max(500),
  })
  .strict()
  .refine(
    (value) =>
      value.projects.length === Math.min(value.limit, value.totalCount) &&
      new Set(value.projects.map((entry) => entry.project.id)).size ===
        value.projects.length,
  );
export type ProjectDirectory = z.infer<typeof projectDirectory>;
export const blankProject = (): ProjectFields => ({
  name: '',
  summary: '',
  clientId: null,
  eventIds: [],
  stage: 'inquiry',
});
export function backwardProjectStage(
  from: ProjectFields['stage'],
  to: ProjectFields['stage'],
) {
  return PROJECT_STAGES.indexOf(to) < PROJECT_STAGES.indexOf(from);
}
export function advanceProject(
  current: SavedProject | null,
  id: string,
  fields: ProjectFields,
  reason: string,
  actorId: string,
  now: string,
): SavedProject {
  const changing = !current || current.stage !== fields.stage;
  if (
    current &&
    backwardProjectStage(current.stage, fields.stage) &&
    !reason.trim()
  )
    throw new Error(
      'Give a reason for moving the project backward or restoring it from the archive.',
    );
  if (!changing && reason)
    throw new Error(
      'A stage-change reason applies only when changing the project stage.',
    );
  const transitionCount = (current?.transitionCount ?? 0) + (changing ? 1 : 0);
  const transitions = [
    ...(current?.transitions ?? []),
    ...(changing
      ? [
          {
            sequence: transitionCount,
            from: current?.stage ?? null,
            to: fields.stage,
            actorId,
            at: now,
            reason,
          },
        ]
      : []),
  ].slice(-30);
  const next = {
    ...fields,
    id,
    version: (current?.version ?? 0) + 1,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
    transitionCount,
    transitions,
  };
  while (
    transitions.length > 1 &&
    new TextEncoder().encode(JSON.stringify(next)).length > 11_000
  )
    transitions.shift();
  if (new TextEncoder().encode(JSON.stringify(next)).length > 11_000)
    throw new Error('The project details exceed the metadata limit.');
  return savedProject.parse(next);
}
