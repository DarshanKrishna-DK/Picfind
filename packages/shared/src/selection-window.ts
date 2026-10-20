export interface SelectionWindow {
  closesAt: string | null;
  serverNow: string;
  closed: boolean;
  invalid: boolean;
}

export function selectionWindow(
  closesAt: unknown,
  now = Date.now(),
): SelectionWindow {
  const configured = closesAt !== undefined && closesAt !== '';
  const deadline =
    configured && typeof closesAt === 'string' ? Date.parse(closesAt) : null;
  const invalid =
    configured &&
    (deadline === null ||
      !Number.isFinite(deadline) ||
      new Date(deadline).toISOString() !== closesAt);
  return {
    closesAt:
      invalid || deadline === null ? null : new Date(deadline).toISOString(),
    serverNow: new Date(now).toISOString(),
    closed: invalid || (deadline !== null && deadline <= now),
    invalid,
  };
}
