import { describe, expect, it } from 'vitest';
import {
  parsePolicyDraft,
  policyDraft,
} from '../../apps/web/src/features/proofing-policy-fields';
import { proofingCountHint } from '../../packages/shared/src/proofing-policy';

describe('collection policy editing', () => {
  it('keeps timestamp precision when editing unrelated fields and permits clearing the deadline', () => {
    const policy = {
      minimum: 1,
      maximum: 2,
      closesAt: '2030-01-02T12:30:59.123Z',
    };
    const draft = policyDraft(policy);
    expect(parsePolicyDraft({ ...draft, maximum: '3' })).toEqual({
      ...policy,
      maximum: 3,
    });
    expect(parsePolicyDraft({ ...draft, deadline: '' }).closesAt).toBeNull();
  });
  it.each([
    { minimum: '' },
    { minimum: '-1' },
    { minimum: '1.5' },
    { maximum: '101' },
    { maximum: '0' },
    { minimum: '3', maximum: '2' },
    { deadline: '2030-02-30T12:30' },
    { deadline: 'not a date' },
  ])('rejects invalid editor values: %j', (change) => {
    expect(() => parsePolicyDraft({ ...policyDraft(), ...change })).toThrow();
  });
  it('gives boundary-specific instructions including explicitly allowed empty submissions', () => {
    const policy = { minimum: 1, maximum: 2, closesAt: null };
    expect(proofingCountHint(0, policy)).toContain('Mark 1 more photo');
    expect(proofingCountHint(2, policy)).toContain('meet the submission count');
    expect(proofingCountHint(3, policy)).toContain('Change 1 favorite');
    expect(proofingCountHint(0, { ...policy, minimum: 0 })).toContain(
      'meet the submission count',
    );
  });
});
