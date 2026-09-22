import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { ArrowUpRight, CreditCard, RefreshCw } from 'lucide-react';
import {
  PHOTO_PLANS,
  catalogPlans,
  type PlanScope,
  type BillingPeriod,
} from '../../../../packages/shared/src/plans';
import './pricing-catalog.css';
import { api, HttpError } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import { BillingUsage } from './billing-usage';
import { SavedPlanStatus } from './plan-status';
import type {
  BillingUsageSummary,
  UsageGrant,
} from '../../../../packages/shared/src/billing-view';

interface BillingSummary extends BillingUsageSummary {
  environment: 'test_mode' | 'live_mode';
  checkoutAvailable: boolean;
  planChangesAvailable?: boolean;
  planChangeCancellationAvailable?: boolean;
  products: string[];
  portalAvailable: boolean;
  reconciliationAvailable?: boolean;
  historyReconciliationAvailable?: boolean;
  paymentHistory?: {
    status: 'running' | 'complete';
    checkedPayments: number;
    startedAt: string;
    through: string;
    completedAt: string | null;
  } | null;
  cancellationAvailable?: boolean;
  deletionPending?: boolean;
  pendingCheckouts?: {
    id: string;
    plan: string;
    currency: 'INR' | 'USD';
    status: string;
    canResume: boolean;
  }[];
  photosRemaining: number;
  searchesRemaining: number;
  deliveryBytesRemaining: number;
  subscriptions: {
    id: string;
    status: string;
    nextBillingAt: string;
    cancelAtPeriodEnd: boolean;
    cancellationPending?: boolean;
  }[];
  grants: UsageGrant[];
}
export function BillingPage() {
  const [search] = useSearchParams();
  const query = useQuery({
    queryKey: ['billing'],
    queryFn: () => api<BillingSummary>('/billing'),
    retry: false,
  });
  const [currency, setCurrency] = useState<'INR' | 'USD'>('INR');
  const [scope, setScope] = useState<PlanScope>(
    search.get('context') === 'organizer' ? 'organizer' : 'personal',
  );
  const [period, setPeriod] = useState<BillingPeriod>('monthly');
  const [selected, setSelected] = useState(
    search.get('context') === 'organizer'
      ? 'organizer-starter-monthly'
      : 'personal-1000',
  );
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const billingDisabled =
    query.error instanceof HttpError && query.error.code === 'BILLING_DISABLED';
  const [cancellation, setCancellation] = useState<{
    id: string;
    mode: 'period-end' | 'immediate';
  } | null>(null);
  const active = useRef(false);
  const attempt = useRef<{ selection: string; id: string } | null>(null);
  const plan = PHOTO_PLANS.find((item) => item.id === selected)!;
  const amount = new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(currency === 'INR' ? plan.inr : plan.usd);
  const date = (value: string) =>
    new Date(value).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  async function open(
    kind: 'checkout' | 'portal',
    saved?: NonNullable<BillingSummary['pendingCheckouts']>[number],
  ) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      const chosenPlan = saved?.plan ?? selected;
      const chosenCurrency = saved?.currency ?? currency;
      const selection = `${chosenPlan}:${chosenCurrency}`;
      if (
        kind === 'checkout' &&
        !saved &&
        attempt.current?.selection !== selection
      )
        attempt.current = { selection, id: crypto.randomUUID() };
      const result = await api<{ url: string }>(
        saved
          ? `/billing/checkout/${encodeURIComponent(saved.id)}/resume`
          : `/billing/${kind}`,
        {
          method: 'POST',
          ...(kind === 'checkout'
            ? {
                body: JSON.stringify(
                  saved
                    ? {}
                    : {
                        requestId: attempt.current!.id,
                        plan: chosenPlan,
                        currency: chosenCurrency,
                        acceptedTerms: saved ? true : accepted,
                      },
                ),
              }
            : {}),
        },
      );
      const url = new URL(result.url);
      if (
        url.protocol !== 'https:' ||
        !url.hostname.endsWith('.dodopayments.com') ||
        url.username ||
        url.password
      )
        throw new Error(
          'The payment provider returned an unexpected address. Please retry.',
        );
      window.location.assign(url.href);
    } catch (failure) {
      setError(failure);
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  async function manage(path: string, body: object, success: string) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      const updated = await api<BillingSummary>(path, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (updated.pendingCheckouts?.length === 0) attempt.current = null;
      await query.refetch();
      setCancellation(null);
      setMessage(success);
    } catch (failure) {
      setError(failure);
      if (path === '/billing/reconcile') await query.refetch();
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="billing-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">CLEAR ALLOWANCES. NO SURPRISES.</p>
          <h1>Billing & usage</h1>
          <p>
            Choose the capacity you need, without automatic overage charges.
          </p>
        </div>
        <button
          className="button secondary"
          disabled={query.isFetching}
          onClick={() =>
            void query.refetch().then((result) => {
              if (
                !result.isError &&
                result.data?.pendingCheckouts?.length === 0
              )
                attempt.current = null;
            })
          }
        >
          <RefreshCw size={17} />
          Refresh balance
        </button>
      </div>
      {search.get('checkout') === 'returned' && (
        <p className="notice" role="status">
          You have returned from checkout. This page does not confirm payment.
          Allowances update only after the provider verifies the purchase;
          refresh the balance in a moment.
        </p>
      )}
      {query.isPending && <Loading />}
      <ErrorNote error={query.error ?? error} />
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {query.error && (
        <div className="glass-panel">
          <h2>
            {billingDisabled
              ? 'Purchases are not enabled.'
              : 'We could not load billing.'}
          </h2>
          <p>
            No purchase was started. Your library and account remain accessible.
          </p>
          <Link className="text-link" to="/app/library">
            Return to your photos
          </Link>
          {billingDisabled && (
            <p>
              <Link className="text-link" to="/pricing">
                Compare personal packs and organizer plans
              </Link>
            </p>
          )}
        </div>
      )}
      {query.data && (
        <>
          {query.data.environment === 'test_mode' && (
            <p className="notice">
              Test billing only. Do not use real card details. Test allowances
              are separate from live purchases.
            </p>
          )}
          {query.data.deletionPending && (
            <p className="notice">
              Account deletion has started. Purchases are disabled. Return to{' '}
              <Link to="/app/settings">Account settings</Link> to finish
              deleting your data.
            </p>
          )}
          {(query.data.pendingCheckouts?.length ?? 0) > 0 && (
            <section
              className="glass-panel"
              aria-labelledby="pending-checkout-heading"
            >
              <h2 id="pending-checkout-heading">Your saved checkout</h2>
              <p>
                Resume the same purchase or check its payment status. A saved
                checkout is not proof of payment, and starting a different
                purchase is disabled until it is resolved.
              </p>
              {query.data.pendingCheckouts!.map((pending) => (
                <div key={pending.id}>
                  <p>
                    {pending.plan.replaceAll('-', ' ')} / {pending.currency} /{' '}
                    {pending.status.replaceAll('_', ' ')}
                  </p>
                  <button
                    className="button secondary"
                    disabled={
                      busy || query.data!.deletionPending || !pending.canResume
                    }
                    onClick={() => void open('checkout', pending)}
                  >
                    Resume saved checkout
                  </button>
                  {!pending.canResume && (
                    <p className="field-help">
                      This checkout cannot be reopened yet. Use Check payment
                      status below to resolve it before starting another
                      purchase.
                    </p>
                  )}
                </div>
              ))}
            </section>
          )}
          <BillingUsage summary={query.data} scope={scope} />
          <div className="billing-columns">
            <section className="glass-panel">
              <h2>Choose your next allowance</h2>
              <div
                className="catalog-toggle"
                role="group"
                aria-label="Purchase context"
              >
                {(['personal', 'organizer'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={scope === value}
                    disabled={busy}
                    onClick={() => {
                      setScope(value);
                      setSelected(catalogPlans(value, period)[0]!.id);
                      setAccepted(false);
                    }}
                  >
                    {value === 'personal'
                      ? 'Personal packs'
                      : 'Organizer plans'}
                  </button>
                ))}
              </div>
              {scope === 'organizer' && (
                <div
                  className="catalog-toggle"
                  role="group"
                  aria-label="Billing period"
                >
                  {(['monthly', 'yearly'] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={period === value}
                      disabled={busy}
                      onClick={() => {
                        setPeriod(value);
                        setSelected(
                          selected.replace(/-(monthly|yearly)$/, `-${value}`),
                        );
                        setAccepted(false);
                      }}
                    >
                      {value === 'monthly' ? 'Monthly' : 'Yearly'}
                    </button>
                  ))}
                </div>
              )}
              <p className="field-help">
                {scope === 'personal'
                  ? 'For finding your own photos. One-time packs never fund event hosting or guest searches.'
                  : 'For hosting events. Guest searches are included, with no per-guest fee. Personal packs are separate.'}
              </p>
              <label>
                Plan
                <select
                  aria-label="Plan"
                  value={selected}
                  disabled={busy}
                  onChange={(e) => {
                    setSelected(e.target.value as typeof selected);
                    setAccepted(false);
                  }}
                >
                  {catalogPlans(scope, period).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Currency
                <select
                  aria-label="Currency"
                  value={currency}
                  disabled={busy}
                  onChange={(e) => {
                    setCurrency(e.target.value as typeof currency);
                    setAccepted(false);
                  }}
                >
                  <option>INR</option>
                  <option>USD</option>
                </select>
              </label>
              <p className="plan-price">
                {amount}
                <small>
                  {plan.cadence === 'month'
                    ? '/month'
                    : plan.cadence === 'year'
                      ? '/year'
                      : ' once'}
                </small>
              </p>
              <p>
                {plan.photos.toLocaleString()} photo attempts{' '}
                {scope === 'organizer' ? 'per month' : ''} and {plan.searches}{' '}
                selfie searches. Taxes are shown in hosted checkout before
                payment.
              </p>
              <p className="field-help">
                {plan.cadence !== 'once'
                  ? `Renews ${plan.cadence === 'year' ? 'yearly' : 'monthly'} until cancelled. Included processing and search allowances reset monthly without rollover. Maximum event retention: ${plan.retentionDays} days.`
                  : 'One-time purchase, not a subscription. Processing credits expire 12 months after purchase.'}{' '}
                Development safety limits remain until launch activation.
              </p>
              <label className="check-label billing-consent">
                <input
                  type="checkbox"
                  checked={accepted}
                  disabled={busy}
                  onChange={(e) => setAccepted(e.target.checked)}
                />
                <span>
                  I agree to the <Link to="/terms">terms</Link> and the{' '}
                  {plan.cadence !== 'once'
                    ? `${plan.cadence === 'year' ? 'yearly' : 'monthly'} renewal`
                    : 'one-time purchase'}{' '}
                  above.
                </span>
              </label>
              <button
                className="button"
                disabled={
                  busy ||
                  !accepted ||
                  !query.data.checkoutAvailable ||
                  Boolean(query.data.pendingCheckouts?.length) ||
                  (scope === 'organizer' &&
                    query.data.subscriptions.some(
                      (sub) =>
                        !['cancelled', 'expired', 'failed'].includes(
                          sub.status,
                        ),
                    )) ||
                  !query.data.products.includes(`${selected}:${currency}`)
                }
                onClick={() => void open('checkout')}
              >
                <CreditCard size={17} />
                {busy ? 'Opening securely...' : 'Continue to secure checkout'}
              </button>
              {!query.data.products.includes(`${selected}:${currency}`) && (
                <p className="notice">
                  Planned. This product is not activated for checkout yet. No
                  payment can be started.
                </p>
              )}
              {scope === 'organizer' &&
                query.data.subscriptions.some(
                  (sub) =>
                    !['cancelled', 'expired', 'failed'].includes(sub.status),
                ) && (
                  <p className="field-help">
                    You already have a subscription. Manage it here instead of
                    starting a second recurring payment. You can add a one-time
                    personal photo pack for your own Discover searches, not for
                    this event.
                  </p>
                )}
              {!query.data.checkoutAvailable && (
                <p className="field-help">
                  Checkout is not activated. No payment can be started.
                </p>
              )}
            </section>
            <section className="glass-panel">
              <h2>Manage your billing</h2>
              <p>
                Invoices, payment methods and cancellation are managed in Dodo's
                secure customer portal. PicFind never stores card details.
              </p>
              <button
                className="button secondary"
                disabled={busy || !query.data.portalAvailable}
                onClick={() => void open('portal')}
              >
                Open billing portal <ArrowUpRight size={17} />
              </button>
              <p>
                <button
                  className="button secondary"
                  disabled={busy || !query.data.reconciliationAvailable}
                  onClick={() =>
                    void manage(
                      '/billing/reconcile',
                      {},
                      'Billing status checked with the provider.',
                    )
                  }
                >
                  {query.data.paymentHistory?.status === 'running'
                    ? 'Continue checking history'
                    : 'Check payment status'}
                </button>
              </p>
              {query.data.historyReconciliationAvailable && (
                <p className="field-help">
                  Checks saved checkouts, renewals, refunds and disputes
                  directly with Dodo, in small resumable batches. It does not
                  charge you or change a subscription.
                </p>
              )}
              {query.data.paymentHistory && (
                <div className="notice" role="status">
                  <strong>
                    {query.data.paymentHistory.status === 'running'
                      ? 'Payment history check in progress'
                      : 'Payment history check completed'}
                  </strong>
                  <p>
                    {query.data.paymentHistory.checkedPayments} PicFind payment
                    checks saved.{' '}
                    {query.data.paymentHistory.status === 'running'
                      ? 'More payment history remains. Continue until complete. You can leave this page and resume later.'
                      : `Checked payments created on or before ${new Date(query.data.paymentHistory.through).toLocaleString()}. Later payments are included in your next check.`}
                  </p>
                </div>
              )}
              {query.data.subscriptions.length ? (
                <ul className="billing-history">
                  {query.data.subscriptions.map((sub) => (
                    <li key={sub.id}>
                      <strong>{sub.status.replaceAll('_', ' ')}</strong>
                      <SavedPlanStatus
                        subscriptionId={sub.id}
                        canConfirm={
                          query.data!.planChangesAvailable === true &&
                          !query.data!.deletionPending
                        }
                        canCancel={
                          query.data!.planChangeCancellationAvailable ===
                            true && !query.data!.deletionPending
                        }
                      />
                      {sub.cancellationPending && (
                        <p className="notice" role="status">
                          A cancellation request still needs confirmation. Plan
                          changes and account deletion are paused until it is
                          resolved. Choose a cancellation action below to retry;
                          each action asks for confirmation before contacting
                          the provider.
                        </p>
                      )}
                      <span>
                        {['cancelled', 'expired', 'failed'].includes(
                          sub.status,
                        ) ? (
                          'No further renewals'
                        ) : (
                          <>
                            {sub.cancelAtPeriodEnd
                              ? 'Renewal cancelled; period ends'
                              : 'Next billing date'}{' '}
                            {date(sub.nextBillingAt)}
                          </>
                        )}
                      </span>
                      {(!['cancelled', 'expired', 'failed'].includes(
                        sub.status,
                      ) ||
                        sub.cancellationPending) &&
                        query.data.cancellationAvailable && (
                          <>
                            {!sub.cancelAtPeriodEnd && (
                              <button
                                className="button secondary"
                                disabled={busy}
                                onClick={() =>
                                  setCancellation({
                                    id: sub.id,
                                    mode: 'period-end',
                                  })
                                }
                              >
                                Cancel renewal
                              </button>
                            )}
                            <button
                              className="button danger-outline"
                              disabled={busy}
                              onClick={() =>
                                setCancellation({
                                  id: sub.id,
                                  mode: 'immediate',
                                })
                              }
                            >
                              Cancel subscription now
                            </button>
                          </>
                        )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="field-help">
                  No subscription is connected to your account.
                </p>
              )}
              {cancellation && (
                <div
                  className="notice"
                  role="region"
                  aria-label="Confirm subscription cancellation"
                >
                  <h3>
                    {cancellation.mode === 'immediate'
                      ? 'Cancel immediately?'
                      : 'Stop the next renewal?'}
                  </h3>
                  <p>
                    {cancellation.mode === 'immediate'
                      ? 'This ends the subscription now so it will not renew. This does not request a refund. Already paid PicFind allowances keep their original expiry.'
                      : 'Your subscription remains active until the end of its billing period, then stops renewing. This does not request a refund.'}
                  </p>
                  <button
                    className="button danger-outline"
                    disabled={busy}
                    onClick={() =>
                      void manage(
                        `/billing/subscriptions/${encodeURIComponent(cancellation.id)}/cancel`,
                        { mode: cancellation.mode, confirmed: true },
                        'Cancellation confirmed by the provider.',
                      )
                    }
                  >
                    Confirm cancellation
                  </button>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => setCancellation(null)}
                  >
                    Keep subscription
                  </button>
                </div>
              )}
              <PlanPreview
                planChangesAvailable={query.data.planChangesAvailable ?? false}
                subscriptions={query.data.subscriptions}
                roleCatalogAvailable={query.data.roleCatalogAvailable ?? false}
                disabled={Boolean(query.data.deletionPending) || busy}
              />
              <h3>How usage works</h3>
              <p>
                An allowance is reserved before indexing or search. Failed
                provider attempts can still incur costs. Viewing results does
                not consume photo-processing credits; photo delivery has a
                separate bandwidth allowance.
              </p>
            </section>
          </div>
          <section className="glass-panel">
            <h2>Your allowances</h2>
            <ul className="billing-history">
              {query.data.grants.map((grant) => (
                <li key={grant.id}>
                  <strong>{grant.plan.replaceAll('-', ' ')}</strong>
                  <span>
                    {grant.entitlementMonths && !grant.parentGrantId
                      ? 'Paid hosting entitlement; monthly credits are listed separately.'
                      : `${grant.parentGrantId ? 'Monthly allowance window: ' : ''}${grant.photosRemaining} photo attempts remaining / ${grant.usedPhotos} used`}
                  </span>
                  <span>
                    Expires {date(grant.expiresAt)}
                    {grant.held ? ' / On hold for a payment dispute' : ''}
                    {grant.refundFraction ? ' / Adjusted for a refund' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </section>
  );
}
import { PlanPreview } from './plan-preview.js';
