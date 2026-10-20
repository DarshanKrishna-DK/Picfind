import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  creditChange,
  creditPresetFields,
  creditPresetWrite,
  creditPreviewWrite,
  savedCreditPreset,
} from '../../packages/shared/src/credit-presets';

const fields = {
  label: 'Studio',
  name: 'Asha Photography',
  website: 'https://example.test/portfolio',
};
describe('private credit presets and explicit batch plans', () => {
  it('validates reusable identity without storing a publication policy', () => {
    expect(creditPresetFields.safeParse(fields).success).toBe(true);
    for (const extra of [
      { published: true },
      { name: '' },
      { website: 'http://example.test' },
      { website: 'https://user:password@example.test' },
      { name: 'Name\nInjected' },
    ])
      expect(
        creditPresetFields.safeParse({ ...fields, ...extra }).success,
      ).toBe(false);
    expect(creditPresetWrite.safeParse({ ...fields, version: 0 }).success).toBe(
      true,
    );
  });
  it('enforces chronology, version capacity, unique photo IDs and batch size', () => {
    const now = new Date().toISOString();
    expect(
      savedCreditPreset.safeParse({
        ...fields,
        id: randomUUID(),
        version: 1,
        createdAt: now,
        updatedAt: now,
      }).success,
    ).toBe(true);
    expect(
      savedCreditPreset.safeParse({
        ...fields,
        id: randomUUID(),
        version: 1,
        createdAt: now,
        updatedAt: '2000-01-01T00:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(
      creditPresetWrite.safeParse({
        ...fields,
        version: Number.MAX_SAFE_INTEGER,
      }).success,
    ).toBe(false);
    const id = randomUUID(),
      proposed = {
        name: fields.name,
        website: fields.website,
        published: false,
      };
    for (const ids of [
      [],
      [id, id],
      Array.from({ length: 101 }, () => randomUUID()),
    ])
      expect(
        creditPreviewWrite.safeParse({ fields: proposed, photoIds: ids })
          .success,
      ).toBe(false);
  });
  it('preserves existing credits by default and distinguishes unchanged publication from replacement', () => {
    const empty = {
      name: '' as const,
      website: '' as const,
      published: false as const,
      version: 0 as const,
      updatedAt: null,
    };
    const proposed = {
      name: fields.name,
      website: fields.website,
      published: false,
    };
    expect(creditChange(empty, proposed, false)).toBe('update');
    const existing = {
      ...proposed,
      published: true,
      version: 1,
      updatedAt: new Date().toISOString(),
    };
    expect(creditChange(existing, proposed, false)).toBe('preserved');
    expect(creditChange(existing, proposed, true)).toBe('update');
    expect(
      creditChange(existing, { ...proposed, published: true }, false),
    ).toBe('unchanged');
  });
});
