import { randomUUID } from 'node:crypto';
import { creditFixture } from './credit-presets';
import {
  TEMPLATE_ACTOR,
  type SavedTemplate,
} from '../../packages/shared/src/coverage-templates';
export function templateFixture() {
  const f = creditFixture(),
    templateId = randomUUID(),
    templateRoot = '/api/studio/coverage-templates';
  const templateFields = {
    title: 'Portrait essentials',
    categories: [
      {
        label: 'Family portraits',
        target: 3,
        note: 'Include both generations',
      },
      { label: 'Venue details', target: 2, note: 'Before guests arrive' },
    ],
  };
  const saveTemplate = (
    changes: object = {},
    current: SavedTemplate | null = null,
    id = templateId,
    actor = f.ownerId,
  ) =>
    f
      .put(
        `${templateRoot}/${id}`,
        {
          fields: templateFields,
          version: current?.version ?? 0,
          generation: current?.generation ?? null,
          ...changes,
        },
        actor,
      )
      .set(TEMPLATE_ACTOR, actor);
  const removeTemplate = (
    current: SavedTemplate,
    id = templateId,
    actor = f.ownerId,
  ) =>
    f
      .remove(
        `${templateRoot}/${id}`,
        { version: current.version, generation: current.generation },
        actor,
      )
      .set(TEMPLATE_ACTOR, actor);
  return {
    ...f,
    templateId,
    templateRoot,
    templateFields,
    saveTemplate,
    removeTemplate,
  };
}
