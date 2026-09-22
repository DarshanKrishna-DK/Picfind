import {
  billingUsage,
  type BillingUsageSummary,
} from '../../../../packages/shared/src/billing-view';
import type { PlanScope } from '../../../../packages/shared/src/plans';

export function BillingUsage({
  summary,
  scope,
}: {
  summary: BillingUsageSummary;
  scope: PlanScope;
}) {
  const usage = billingUsage(summary, scope);
  const date = (value: string) => new Date(value).toLocaleDateString();
  return (
    <section aria-label="Current allowance">
      <h2>
        {usage.scoped
          ? scope === 'personal'
            ? 'Your personal allowance'
            : 'Your organizer allowance'
          : 'Your existing account allowance'}
      </h2>
      <p>{usage.label}</p>
      {!usage.available ? (
        <p role="status">Usage unavailable. Refresh your balance to retry.</p>
      ) : (
        <div className="billing-metrics">
          <article className="glass-panel">
            <span>Photo processing attempts remaining</span>
            <strong>{usage.photosRemaining.toLocaleString()}</strong>
          </article>
          <article className="glass-panel">
            <span>Selfie searches remaining</span>
            <strong>{usage.searchesRemaining.toLocaleString()}</strong>
          </article>
          <article className="glass-panel">
            <span>Delivery remaining</span>
            <strong>
              {usage.deliveryBytesRemaining === null
                ? 'Unavailable'
                : `${(usage.deliveryBytesRemaining / 1e9).toFixed(2)} GB`}
            </strong>
          </article>
        </div>
      )}
      <p className="field-help">
        {usage.storageBytesUsed === null
          ? 'Storage usage is not yet reconciled.'
          : `${(usage.storageBytesUsed / 1e9).toFixed(2)} GB stored in ${usage.scoped ? scope : 'this account'}.`}
        {usage.storageBytesLimit !== null &&
          ` Storage allowance: ${(usage.storageBytesLimit / 1e9).toFixed(2)} GB.`}
      </p>
      {usage.sharedLegacy && (
        <p className="notice">
          Legacy credits are shared between personal and organizer use. These
          displayed balances overlap; do not add them together.
          {usage.sharedStorageUsed !== null &&
            ` Legacy shared storage: ${(usage.sharedStorageUsed / 1e9).toFixed(2)} GB.`}
        </p>
      )}
      {!usage.scoped && (
        <p className="field-help">
          This is your existing account balance, not separate personal and
          organizer credit pools. New plan checkout remains subject to
          availability.
        </p>
      )}
      {usage.windowEndsAt && (
        <p>
          Current monthly allowance ends {date(usage.windowEndsAt)}. Unused
          monthly credits do not roll over.
        </p>
      )}
      {usage.paidThrough && (
        <p>
          Paid hosting entitlement through {date(usage.paidThrough)}. Future
          monthly allowances are not available to spend now.
        </p>
      )}
    </section>
  );
}
