import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { AccountDialog } from './account-dialog';

export interface Quote {
  quoteId: string;
  targetPlan: string;
  currency: 'INR' | 'USD';
  recurringBeforeTax: number;
  chargeNow: number;
  effectiveAt: string;
  expiresAt: string;
}

export function PlanConfirmation({
  subscriptionId,
  targetPlan,
  savedQuote,
}: {
  subscriptionId: string;
  targetPlan: string;
  savedQuote?: Quote;
}) {
  const cache = useQueryClient();
  const lock = useRef(false);
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [message, setMessage] = useState('');
  async function review() {
    if (lock.current) return;
    lock.current = true;
    setOpened(true);
    setBusy(true);
    setQuote(null);
    setAccepted(false);
    setSubmitted(false);
    setMessage('');
    try {
      const result =
        savedQuote ??
        (await api<Quote>(
          `/billing/subscriptions/${encodeURIComponent(subscriptionId)}/plan-quote`,
          { method: 'POST', body: JSON.stringify({ plan: targetPlan }) },
        ));
      if (
        !/^[a-f0-9-]{36}$/i.test(result.quoteId) ||
        result.targetPlan !== targetPlan ||
        result.chargeNow !== 0 ||
        !['INR', 'USD'].includes(result.currency) ||
        !Number.isSafeInteger(result.recurringBeforeTax) ||
        result.recurringBeforeTax < 0 ||
        !Number.isFinite(Date.parse(result.effectiveAt)) ||
        !Number.isFinite(Date.parse(result.expiresAt)) ||
        Date.parse(result.expiresAt) <= Date.now()
      )
        throw new Error('Invalid quote');
      setQuote(result);
    } catch {
      setMessage(
        'A current quote could not be prepared. No plan change was submitted. Close this dialog and refresh billing before trying again.',
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function confirm() {
    if (lock.current || !quote || !accepted || submitted) return;
    if (Date.parse(quote.expiresAt) <= Date.now()) {
      setQuote(null);
      setMessage(
        'This quote has expired. Close this dialog and request fresh pricing.',
      );
      return;
    }
    lock.current = true;
    setBusy(true);
    setSubmitted(true);
    try {
      const result = await api<{ status: string }>(
        `/billing/subscriptions/${encodeURIComponent(subscriptionId)}/confirm`,
        {
          method: 'POST',
          body: JSON.stringify({ quoteId: quote.quoteId, confirmed: true }),
        },
      );
      setMessage(
        result.status === 'scheduled'
          ? 'Your plan change is scheduled. Your current allowances remain unchanged until the new period.'
          : 'Check the saved plan-change status below for the latest outcome.',
      );
    } catch {
      setMessage(
        'The outcome needs confirmation. Close this dialog and use Check existing attempt if shown below. Do not submit another plan change.',
      );
    } finally {
      await cache.invalidateQueries({
        queryKey: ['billing-plan-status', subscriptionId],
      });
      await cache.invalidateQueries({ queryKey: ['billing'] });
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="button secondary"
        onClick={() => void review()}
      >
        Review plan change
      </button>
      {opened && (
        <AccountDialog
          title="Confirm renewal plan change"
          busy={busy}
          close={() => setOpened(false)}
        >
          {busy && (
            <p role="status">
              {submitted
                ? 'Confirming saved quote...'
                : 'Preparing current renewal quote...'}
            </p>
          )}
          {quote && !submitted && (
            <>
              <p>
                <strong>{quote.targetPlan.replaceAll('-', ' ')}</strong>
              </p>
              <p>
                {new Intl.NumberFormat(undefined, {
                  style: 'currency',
                  currency: quote.currency,
                }).format(quote.recurringBeforeTax / 100)}{' '}
                per {quote.targetPlan.endsWith('-yearly') ? 'year' : 'month'}{' '}
                before tax, starting{' '}
                {new Date(quote.effectiveAt).toLocaleDateString()}.
              </p>
              <p>
                Nothing is due today. Renewal continues until cancelled. Taxes
                may apply at renewal. Your current paid allowances are not
                increased by scheduling this change.
              </p>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={accepted}
                  disabled={busy}
                  onChange={(e) => setAccepted(e.target.checked)}
                />
                I agree to this plan and recurring renewal price.
              </label>
              <button
                type="button"
                className="button"
                disabled={!accepted || busy}
                onClick={() => void confirm()}
              >
                Confirm plan change
              </button>
            </>
          )}
          {message && <p role="status">{message}</p>}
        </AccountDialog>
      )}
    </>
  );
}
