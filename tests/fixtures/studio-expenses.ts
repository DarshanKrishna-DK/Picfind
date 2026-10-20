import { randomUUID } from 'node:crypto';
import { questionnaireFixture } from './questionnaires';
import {
  blankExpense,
  type StudioExpense,
} from '../../packages/shared/src/studio-expenses';

export function expenseFixture() {
  const f = questionnaireFixture(),
    expenseId = randomUUID(),
    root = '/api/studio/expenses';
  const fields = {
    ...blankExpense(),
    title: 'Train to event',
    merchant: 'Rail service',
    category: 'travel' as const,
    incurredOn: '2026-10-21',
    amountMinor: 125050,
    note: 'Return journey',
    projectId: f.projectId,
  };
  const save = (
    changes: object = {},
    current: StudioExpense | null = null,
    id: string = expenseId,
    actor = f.ownerId,
  ) =>
    f.put(
      `${root}/${id}`,
      {
        ...fields,
        ...changes,
        version: current?.version ?? 0,
        generation: current?.generation ?? null,
      },
      actor,
    );
  const removeEntry = (
    current: StudioExpense,
    id: string = expenseId,
    actor = f.ownerId,
  ) =>
    f.remove(
      `${root}/${id}`,
      { version: current.version, generation: current.generation },
      actor,
    );
  return { ...f, root, expenseId, fields, save, removeEntry };
}
