import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { ORGANIZER_PLANS } from '../../../../packages/shared/src/plans.js';
import { PlanConfirmation } from './plan-confirmation';

const planLabel = (id: string) => {
  const name = id.startsWith('organizer-') ? id.split('-')[1]! : id;
  return name.charAt(0).toUpperCase() + name.slice(1);
};

interface Preview {
  subscriptionId: string;
  targetPlan: string;
  currency: 'INR' | 'USD';
  chargeNow: number;
  recurringBeforeTax: number;
  effectiveAt: string;
  expiresAt: string;
  previewOnly: true;
}
interface Subscription {
  id: string;
  status: string;
  cancelAtPeriodEnd: boolean;
  nextBillingAt: string;
}
export function PlanPreview({
  subscriptions,
  disabled,
  roleCatalogAvailable = false,
  planChangesAvailable = false,
}: {
  subscriptions: Subscription[];
  disabled: boolean;
  roleCatalogAvailable?: boolean;
  planChangesAvailable?: boolean;
}) {
  const eligible = subscriptions.filter(
    (sub) => sub.status === 'active' && !sub.cancelAtPeriodEnd,
  );
  const [target, setTarget] = useState<string>(
    roleCatalogAvailable ? 'organizer-pro-monthly' : 'studio',
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  const active = useRef(false);
  const generation = useRef(0);
  const signature = JSON.stringify(
    eligible.map((sub) => [sub.id, sub.nextBillingAt]),
  );
  useEffect(() => {
    generation.current++;
    setPreview(null);
    setError('');
  }, [signature, disabled, roleCatalogAvailable]);
  useEffect(() => {
    if (!preview) return;
    const timer = window.setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [preview]);
  async function requestPreview() {
    if (active.current || disabled || eligible.length !== 1) return;
    active.current = true;
    setBusy(true);
    setError('');
    setPreview(null);
    setExpired(false);
    const requestGeneration = generation.current;
    try {
      const result = await api<Preview>(
        `/billing/subscriptions/${encodeURIComponent(eligible[0]!.id)}/plan-preview`,
        {
          method: 'POST',
          body: JSON.stringify({ plan: target }),
        },
      );
      if (requestGeneration !== generation.current) return;
      if (
        result.previewOnly !== true ||
        result.chargeNow !== 0 ||
        result.targetPlan !== target ||
        result.subscriptionId !== eligible[0]!.id ||
        !['INR', 'USD'].includes(result.currency) ||
        !Number.isSafeInteger(result.recurringBeforeTax) ||
        result.recurringBeforeTax < 0 ||
        !Number.isFinite(Date.parse(result.effectiveAt)) ||
        !Number.isFinite(Date.parse(result.expiresAt))
      )
        throw new Error(
          'The preview could not be displayed safely. No plan change was made.',
        );
      setExpired(Date.parse(result.expiresAt) <= Date.now());
      setPreview(result);
    } catch (failure) {
      if (requestGeneration === generation.current)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Preview unavailable. Your subscription has not changed.',
        );
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  if (eligible.length !== 1 || disabled) return null;
  const money = (amount: number, currency: string) =>
    new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(
      amount / 100,
    );
  return (
    <section aria-labelledby="plan-preview-heading" className="glass-panel">
      <h3 id="plan-preview-heading">Preview another subscription plan</h3>
      <p>
        Compare the provider's renewal price without changing your subscription
        or charging your payment method.
      </p>
      <label>
        Plan to preview
        <select
          aria-label="Plan to preview"
          value={target}
          disabled={busy}
          onChange={(event) => {
            generation.current++;
            setTarget(event.target.value as typeof target);
            setPreview(null);
            setError('');
          }}
        >
          {roleCatalogAvailable && (
            <optgroup label="Organizer plans">
              {ORGANIZER_PLANS.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {planLabel(plan.id)} -{' '}
                  {plan.id.endsWith('-yearly') ? 'Yearly' : 'Monthly'}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Legacy subscriptions only">
            <option value="creator">Creator</option>
            <option value="studio">Studio</option>
          </optgroup>
        </select>
      </label>
      <button
        className="button secondary"
        disabled={busy}
        onClick={() => void requestPreview()}
      >
        {busy ? 'Checking renewal price...' : 'Preview renewal price'}
      </button>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {preview && (
        <div className="notice" role="status">
          <strong>
            {expired ? 'Preview expired' : 'Preview only. No plan change made.'}
          </strong>
          {!expired && (
            <>
              <p>Due today: {money(preview.chargeNow, preview.currency)}</p>
              <p>
                {planLabel(preview.targetPlan)}:{' '}
                {money(preview.recurringBeforeTax, preview.currency)} per{' '}
                {preview.targetPlan.endsWith('-yearly') ? 'year' : 'month'}{' '}
                before tax.
              </p>
              <p>
                Potential start:{' '}
                {new Date(preview.effectiveAt).toLocaleDateString()}. Final
                taxes and pricing may change before renewal.
              </p>
            </>
          )}
          <p>
            {expired
              ? 'Request a fresh preview to check current pricing.'
              : 'Your current paid allowances and renewal are unchanged. This estimate expires in five minutes or at renewal, whichever is sooner.'}
          </p>
        </div>
      )}
      {planChangesAvailable && (
        <PlanConfirmation
          key={`${eligible[0]!.id}:${target}`}
          subscriptionId={eligible[0]!.id}
          targetPlan={target}
        />
      )}
      {!planChangesAvailable && (
        <p className="field-help">
          Plan-change confirmation is not enabled yet. You can keep your
          subscription or cancel renewal. Personal photo packs do not add event
          allowances. Legacy subscriptions cannot migrate through this preview.
        </p>
      )}
    </section>
  );
}
