import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api } from '../api';
import { PlanCancellation } from './plan-cancellation';
import { PlanConfirmation } from './plan-confirmation';

const messages = {
  discarded: 'Unsubmitted quote discarded. Your subscription is unchanged.',
  quoted: 'Quote prepared. No plan change has been submitted.',
  approved: 'Confirmation saved. The plan change has not been submitted.',
  submitting:
    'Plan change awaiting confirmation. Do not submit another change.',
  scheduled: 'Plan change scheduled for your next billing period.',
  cancelling: 'Scheduled change cancellation awaiting confirmation.',
  completed: 'Plan change applied.',
  cancelled:
    'Scheduled plan change cancelled. This does not cancel your subscription.',
};
interface SavedChange {
  quoteId: string;
  plan: string;
  status: keyof typeof messages;
  currency: 'INR' | 'USD';
  recurringBeforeTax: number;
  effectiveAt: string;
  expiresAt: string;
  expired: boolean;
}

export function SavedPlanStatus({
  subscriptionId,
  canCancel = false,
  canConfirm = false,
}: {
  subscriptionId: string;
  canCancel?: boolean;
  canConfirm?: boolean;
}) {
  const cache = useQueryClient();
  const active = useRef(false);
  const [recovering, setRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState('');
  const query = useQuery({
    queryKey: ['billing-plan-status', subscriptionId],
    queryFn: () =>
      api<{ change: SavedChange | null }>(
        `/billing/subscriptions/${encodeURIComponent(subscriptionId)}/plan-status`,
      ),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const change = query.data?.change;
  async function recover() {
    if (
      active.current ||
      !change ||
      !['submitting', 'cancelling'].includes(change.status)
    )
      return;
    active.current = true;
    setRecovering(true);
    setRecoveryError('');
    try {
      await api(
        `/billing/subscriptions/${encodeURIComponent(subscriptionId)}/recover-change`,
        {
          method: 'POST',
          body: JSON.stringify({
            quoteId: change.quoteId,
            operation: change.status === 'cancelling' ? 'cancel' : 'schedule',
          }),
        },
      );
      await cache.invalidateQueries({ queryKey: ['billing'] });
    } catch {
      setRecoveryError(
        'Confirmation is still unavailable. Your existing attempt is saved; no new plan change was submitted. You can check again later.',
      );
    } finally {
      await query.refetch();
      active.current = false;
      setRecovering(false);
    }
  }
  async function discard() {
    if (
      active.current ||
      !change ||
      !['quoted', 'approved'].includes(change.status)
    )
      return;
    active.current = true;
    setRecovering(true);
    setRecoveryError('');
    try {
      await api(
        `/billing/subscriptions/${encodeURIComponent(subscriptionId)}/discard-quote`,
        {
          method: 'POST',
          body: JSON.stringify({ quoteId: change.quoteId, confirmed: true }),
        },
      );
    } catch {
      setRecoveryError(
        'This quote could not be discarded. Check its status before starting another change.',
      );
    } finally {
      await query.refetch();
      active.current = false;
      setRecovering(false);
    }
  }
  if (!query.isPending && !query.isError && !change) return null;
  return (
    <div className="notice" aria-label="Saved plan change">
      {query.isPending ? (
        <p role="status">Loading saved plan change...</p>
      ) : query.isError ? (
        <p>
          Saved plan-change status is unavailable. This check has not changed
          your subscription.
        </p>
      ) : (
        change && (
          <>
            <p role="status">
              <strong>
                {messages[change.status] ?? 'Plan-change status needs review.'}
              </strong>
            </p>
            <p>{change.plan.replaceAll('-', ' ')}</p>
            {change.status === 'quoted' && change.expired ? (
              <p>
                This quote has expired. Request fresh pricing before confirming
                a change.
              </p>
            ) : (
              ['quoted', 'approved', 'scheduled', 'submitting'].includes(
                change.status,
              ) && (
                <p>
                  Quoted renewal:{' '}
                  {new Intl.NumberFormat(undefined, {
                    style: 'currency',
                    currency: change.currency,
                  }).format(change.recurringBeforeTax / 100)}{' '}
                  per {change.plan.endsWith('-yearly') ? 'year' : 'month'}{' '}
                  before tax. Effective{' '}
                  {new Date(change.effectiveAt).toLocaleDateString()}.
                </p>
              )
            )}
          </>
        )
      )}
      {change && ['submitting', 'cancelling'].includes(change.status) && (
        <>
          <button
            type="button"
            className="button secondary"
            disabled={recovering || query.isFetching}
            onClick={() => void recover()}
          >
            {recovering
              ? 'Checking existing attempt...'
              : 'Check existing attempt'}
          </button>
          <p className="field-help">
            Checks the provider for this saved attempt only. Does not start a
            new change or cancellation.
          </p>
        </>
      )}
      {canCancel && change?.status === 'scheduled' && (
        <PlanCancellation
          subscriptionId={subscriptionId}
          quoteId={change.quoteId}
        />
      )}
      {canConfirm && change?.status === 'approved' && (
        <PlanConfirmation
          subscriptionId={subscriptionId}
          targetPlan={change.plan}
          savedQuote={{ ...change, targetPlan: change.plan, chargeNow: 0 }}
        />
      )}
      {change && ['quoted', 'approved'].includes(change.status) && (
        <>
          <button
            type="button"
            className="button secondary"
            disabled={recovering || query.isFetching}
            onClick={() => void discard()}
          >
            Discard unsubmitted quote
          </button>
          <p className="field-help">
            Clears this quote so you can request fresh pricing. Does not change
            or cancel your subscription.
          </p>
        </>
      )}
      {recoveryError && <p role="alert">{recoveryError}</p>}
      <button
        type="button"
        className="button secondary"
        disabled={query.isFetching || recovering}
        onClick={() => void query.refetch()}
      >
        {query.isFetching
          ? 'Checking saved status...'
          : 'Refresh plan-change status'}
      </button>
      <p className="field-help">
        Reads saved PicFind status only. Does not charge you or resubmit a plan
        change.
      </p>
    </div>
  );
}
