import {
  DEFAULT_PROOFING_POLICY,
  type ProofingSubmissionPolicy,
} from '../../../../packages/shared/src/proofing-policy';
import { localDeadlineInput } from './selection-window';

export function policyDraft(policy = DEFAULT_PROOFING_POLICY) {
  return {
    minimum: String(policy.minimum),
    maximum: String(policy.maximum),
    deadline: localDeadlineInput(policy.closesAt),
    originalDeadline: policy.closesAt,
  };
}

type PolicyDraft = ReturnType<typeof policyDraft>;

export function parsePolicyDraft(draft: PolicyDraft): ProofingSubmissionPolicy {
  const minimum = Number(draft.minimum),
    maximum = Number(draft.maximum);
  if (
    !draft.minimum.trim() ||
    !draft.maximum.trim() ||
    !Number.isInteger(minimum) ||
    !Number.isInteger(maximum) ||
    minimum < 0 ||
    minimum > maximum ||
    maximum < 1 ||
    maximum > 100
  )
    throw new Error(
      'Choose a minimum from 0 to 100 and a maximum from 1 to 100, with minimum no greater than maximum.',
    );
  let closesAt: string | null = null;
  if (draft.deadline) {
    const date = new Date(draft.deadline);
    if (
      !Number.isFinite(date.getTime()) ||
      localDeadlineInput(date.toISOString()) !== draft.deadline
    )
      throw new Error('Choose a valid deadline in your device time zone.');
    closesAt =
      draft.deadline === localDeadlineInput(draft.originalDeadline)
        ? draft.originalDeadline
        : date.toISOString();
  }
  return { minimum, maximum, closesAt };
}

export function ProofingPolicyFields({
  value,
  onChange,
  disabled,
  photoCount,
}: {
  value: PolicyDraft;
  onChange: (value: PolicyDraft) => void;
  disabled: boolean;
  photoCount: number;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend>Final submission rules</legend>
      <label>
        Minimum final favorites
        <input
          type="number"
          min={0}
          max={Math.min(photoCount, Number(value.maximum) || 100)}
          required
          step={1}
          value={value.minimum}
          onChange={(event) =>
            onChange({ ...value, minimum: event.target.value })
          }
        />
      </label>
      <label>
        Maximum final favorites
        <input
          type="number"
          min={Math.max(1, Number(value.minimum) || 0)}
          max={100}
          required
          step={1}
          value={value.maximum}
          onChange={(event) =>
            onChange({ ...value, maximum: event.target.value })
          }
        />
      </label>
      <label>
        Final submission deadline
        <input
          type="datetime-local"
          value={value.deadline}
          onChange={(event) =>
            onChange({ ...value, deadline: event.target.value })
          }
        />
      </label>
      <p>
        Time zone: {Intl.DateTimeFormat().resolvedOptions().timeZone}. Leave the
        deadline empty for no deadline. A past deadline closes new final
        submissions. Draft choices remain editable.
      </p>
    </fieldset>
  );
}
