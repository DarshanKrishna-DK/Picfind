import { expenseFixture } from './studio-expenses';
import { BUDGET_ACTOR } from '../../packages/shared/src/project-budgets';
import { budgetRecordId } from '../../apps/api/src/project-budgets';

export function budgetFixture() {
  const f = expenseFixture();
  const root = `/api/studio/projects/${f.projectId}/budget`;
  const projectCreatedAt = f.records.get(f.projectId)!.studioProject!.createdAt;
  const fields = {
    limits: [{ currency: 'INR' as const, amountMinor: 150000 }],
    note: 'Travel and crew ceiling',
  };
  const writeBudget = (
    changes: object = {},
    actor = f.ownerId,
    expected = actor,
  ) =>
    f
      .put(root, { version: 0, projectCreatedAt, fields, ...changes }, actor)
      .set(BUDGET_ACTOR, expected);
  return {
    ...f,
    budgetRoot: root,
    budgetId: budgetRecordId(f.projectId, projectCreatedAt),
    projectCreatedAt,
    budgetFields: fields,
    writeBudget,
  };
}
