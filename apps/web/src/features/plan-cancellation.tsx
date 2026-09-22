import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { AccountDialog } from './account-dialog';

export function PlanCancellation({
  subscriptionId,
  quoteId,
}: {
  subscriptionId: string;
  quoteId: string;
}) {
  const cache = useQueryClient();
  const lock = useRef(false);
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [message, setMessage] = useState('');
  async function cancel() {
    if (lock.current || attempted) return;
    lock.current = true;
    setBusy(true);
    setAttempted(true);
    try {
      const result = await api<{ status: string }>(
        `/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel-change`,
        { method: 'POST', body: JSON.stringify({ quoteId, confirmed: true }) },
      );
      setMessage(
        result.status === 'cancelled'
          ? 'The scheduled change was cancelled. Your subscription remains active.'
          : 'The plan change has already applied or needs review. Check the saved status after closing this dialog.',
      );
    } catch {
      setMessage(
        'Cancellation is not confirmed. Close this dialog and use Check existing attempt if available. Your subscription has not been cancelled by this action.',
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function close() {
    setOpened(false);
    if (attempted) {
      void cache.invalidateQueries({
        queryKey: ['billing-plan-status', subscriptionId],
      });
      void cache.invalidateQueries({ queryKey: ['billing'] });
    }
  }
  return (
    <>
      <button
        type="button"
        className="button secondary"
        onClick={() => {
          setOpened(true);
          setAttempted(false);
          setMessage('');
        }}
      >
        Cancel scheduled change
      </button>
      {opened && (
        <AccountDialog
          title="Cancel scheduled plan change?"
          busy={busy}
          close={close}
        >
          <p>
            This withdraws the upcoming plan change only. It does not cancel
            your subscription, stop its current renewal, or request a refund.
          </p>
          {!attempted && (
            <button
              type="button"
              className="button danger-outline"
              disabled={busy}
              onClick={() => void cancel()}
            >
              Confirm scheduled-change cancellation
            </button>
          )}
          {busy && <p role="status">Checking cancellation...</p>}
          {message && <p role="status">{message}</p>}
        </AccountDialog>
      )}
    </>
  );
}
