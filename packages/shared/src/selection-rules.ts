export interface SelectionCountRules {
  minimum: number;
  maximum: number;
}

export const DEFAULT_SELECTION_RULES: SelectionCountRules = {
  minimum: 1,
  maximum: 100,
};

export function validSelectionRules(rules: SelectionCountRules) {
  return (
    Number.isInteger(rules.minimum) &&
    Number.isInteger(rules.maximum) &&
    rules.minimum >= 1 &&
    rules.maximum <= 100 &&
    rules.minimum <= rules.maximum
  );
}

export function selectionCountHint(count: number, rules: SelectionCountRules) {
  if (count < rules.minimum)
    return `Choose ${rules.minimum - count} more ${rules.minimum - count === 1 ? 'photo' : 'photos'} to send this request.`;
  if (count > rules.maximum)
    return `Remove ${count - rules.maximum} ${count - rules.maximum === 1 ? 'photo' : 'photos'} before sending.`;
  return `${count} selected. You can send this request.`;
}
