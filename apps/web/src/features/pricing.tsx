import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowUpRight, Check } from 'lucide-react';
import { MenuSelect } from '../components/menu-select';
import {
  catalogPlans,
  estimatePlan,
  type PlanScope,
  type BillingPeriod,
} from '../../../../packages/shared/src/plans';
import './sources.css';
import './pricing-catalog.css';

export function Pricing({ embedded = false }: { embedded?: boolean }) {
  const [scope, setScope] = useState<PlanScope>('personal');
  const [period, setPeriod] = useState<BillingPeriod>('monthly');
  const [currency, setCurrency] = useState<'INR' | 'USD'>('INR');
  const [photos, setPhotos] = useState(1000);
  const plans = catalogPlans(scope, period);
  const estimate = estimatePlan(
    photos,
    scope === 'organizer',
    currency,
    period,
  );
  const amount = (inr: number, usd: number) =>
    new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(currency === 'INR' ? inr : usd);
  const Heading = embedded ? 'h2' : 'h1';
  return (
    <section
      id="pricing"
      className={embedded ? 'wrap landing-pricing' : 'wrap standalone'}
    >
      <p className="eyebrow">A PLAN FOR YOUR SIDE OF THE CAMERA</p>
      <Heading>
        Find your photos.
        <br />
        Or host the whole event.
      </Heading>
      <p className="lede">
        One-time packs for your own collections. Organizer plans for event
        galleries and guest searches. No per-guest fee. No automatic overage
        charges.
      </p>
      <div className="catalog-toolbar">
        <div
          className="catalog-toggle"
          role="group"
          aria-label="Pricing audience"
          data-on={scope === 'organizer' ? '1' : '0'}
        >
          <span className="catalog-toggle-thumb" aria-hidden="true" />
          <button
            type="button"
            aria-pressed={scope === 'personal'}
            onClick={() => setScope('personal')}
          >
            Personal packs
          </button>
          <button
            type="button"
            aria-pressed={scope === 'organizer'}
            onClick={() => setScope('organizer')}
          >
            Organizer plans
          </button>
        </div>
        <label className="catalog-currency">
          Display currency
          <MenuSelect
            label="Display currency"
            value={currency}
            onChange={(next) => setCurrency(next as 'INR' | 'USD')}
            options={[
              { value: 'INR', label: 'INR' },
              { value: 'USD', label: 'USD' },
            ]}
          />
        </label>
      </div>
      <div className="catalog-context">
        <div>
          <h3>
            {scope === 'personal'
              ? 'For finding your photos'
              : 'For hosting an event'}
          </h3>
          <p>
            {scope === 'personal'
              ? 'Connect a folder or upload a collection, then search for yourself. No monthly or yearly subscription.'
              : 'Own the gallery, invite your team, and let signed-in guests browse, download and find their photos. Guest usage comes from your organizer allowance.'}
          </p>
        </div>
        {scope === 'organizer' && (
          <div>
            <div
              className="catalog-toggle"
              role="group"
              aria-label="Organizer billing period"
              data-on={period === 'yearly' ? '1' : '0'}
            >
              <span className="catalog-toggle-thumb" aria-hidden="true" />
              <button
                type="button"
                aria-pressed={period === 'monthly'}
                onClick={() => setPeriod('monthly')}
              >
                Monthly
              </button>
              <button
                type="button"
                aria-pressed={period === 'yearly'}
                onClick={() => setPeriod('yearly')}
              >
                Yearly
              </button>
            </div>
            <p className="field-help">
              Yearly includes 2 months free. Allowances reset monthly.
            </p>
          </div>
        )}
      </div>
      <div className="plan-grid role-plan-grid">
        {plans.map((plan) => (
          <article
            className={`plan-card ${plan.recommended ? 'featured' : ''}`}
            key={plan.id.replace(/-(monthly|yearly)$/, '')}
            aria-label={plan.name}
          >
            {plan.recommended && (
              <p className="plan-badge">
                {scope === 'personal' ? 'Best per-photo price' : 'Recommended'}
              </p>
            )}
            <h3>{plan.name}</h3>
            <p
              className="plan-price catalog-price"
              key={`${plan.id}:${currency}`}
            >
              {amount(plan.inr, plan.usd)}
              <small>
                {plan.cadence === 'once'
                  ? ' once'
                  : plan.cadence === 'year'
                    ? '/year'
                    : '/month'}
              </small>
            </p>
            <p className="field-help">
              {plan.cadence === 'year'
                ? 'Billed yearly. Two months free.'
                : plan.cadence === 'month'
                  ? 'Billed monthly. Cancel renewal anytime.'
                  : `${amount(plan.inr / plan.photos, plan.usd / plan.photos)} per photo processed.`}
            </p>
            <ul>
              {[
                `${plan.photos.toLocaleString()} photos processed${scope === 'organizer' ? ' per month' : ''}`,
                `${plan.searches.toLocaleString()} selfie searches${scope === 'organizer' ? ' per month' : ''}`,
                `${plan.storageGb} GB optimized storage`,
                `${plan.deliveryGb} GB delivery${scope === 'organizer' ? ' per month' : ''}`,
                scope === 'organizer'
                  ? `Up to ${plan.retentionDays} days of event retention`
                  : `${plan.retentionDays}-day personal photo retention`,
                ...(scope === 'organizer'
                  ? [`${plan.liveEvents} live events`, 'No per-guest charge']
                  : ['Personal use only; no event hosting']),
              ].map((feature) => (
                <li key={feature}>
                  <Check size={16} />
                  {feature}
                </li>
              ))}
            </ul>
            <p className="field-help">
              Planned pricing. Availability is shown in Billing before any
              purchase.
            </p>
            <Link
              className="button secondary"
              to={`/app/billing?context=${scope}`}
            >
              View availability <ArrowUpRight size={16} />
            </Link>
          </article>
        ))}
      </div>
      <p className="catalog-trial">
        Not ready to buy? The free personal trial includes 20 photo-processing
        attempts and 20 searches, with 7-day retention.{' '}
        <Link className="text-link" to="/app/discover/new">
          Try your own collection
        </Link>
      </p>
      <section className="source-panel price-estimator">
        <div>
          <h3>See the budget before you upload.</h3>
          <p>
            {scope === 'personal'
              ? 'We compare pack combinations to find the lowest price for your collection. Packs do not fund event hosting.'
              : 'Estimate one organizer plan for your monthly processing needs. Personal packs cannot top up event allowances. Storage, searches, delivery and live-event limits also apply.'}
          </p>
        </div>
        <div className="price-estimator-form">
          <label>
            {scope === 'personal'
              ? 'Photos to process'
              : 'Photos to process per month'}
            <input
              type="number"
              min="0"
              max="100000"
              value={photos}
              onChange={(e) =>
                setPhotos(Math.min(100000, Math.max(0, Number(e.target.value))))
              }
            />
          </label>
          <p role="status" className="estimate-result">
            {estimate.fits ? (
              <>
                {estimate.items
                  .map((item) => `${item.quantity} x ${item.plan.name}`)
                  .join(' + ')}
                : <strong>{amount(estimate.inr, estimate.usd)}</strong>
                {scope === 'organizer'
                  ? ` / ${period === 'yearly' ? 'year' : 'month'}`
                  : ' once'}
              </>
            ) : (
              'This volume exceeds the largest included monthly cap. Process within the allowance or spread processing across monthly periods; no automatic overage is charged.'
            )}
          </p>
        </div>
      </section>
      <div className="launch-faq">
        <details>
          <summary>
            Who pays when a guest searches?
            <span aria-hidden="true" />
          </summary>
          <p>
            The organizer. A guest signs in through the secret event link, but
            does not buy a pack or subscription for that event. Personal packs
            are only for the buyer's own Discover collections.
          </p>
        </details>
        <details>
          <summary>
            What does yearly billing include?
            <span aria-hidden="true" />
          </summary>
          <p>
            One yearly payment costs ten monthly payments. Processing, searches
            and delivery reset monthly without rollover; yearly billing does not
            grant all twelve months of processing at once. Event retention is a
            separate limit of 30, 90 or 365 days, depending on the tier.
          </p>
        </details>
        <details>
          <summary>
            How long are photos available?
            <span aria-hidden="true" />
          </summary>
          <p>
            Personal trial uploads last seven days; paid personal uploads last
            thirty days. Organizers choose each event's expiry within their
            tier's cap. An expired event is unavailable, even if background
            deletion needs another attempt. Keep your originals separately.
          </p>
        </details>
        <details>
          <summary>
            What counts as a processed photo?
            <span aria-hidden="true" />
          </summary>
          <p>
            An indexing attempt counts even when no face is detectable. A ready
            photo is reused in its collection; another collection requires new
            processing. Selfie searches and photo delivery have separate
            allowances. Provider failures and cancelled downloads can still
            incur usage.
          </p>
        </details>
        <details>
          <summary>
            Are taxes included?
            <span aria-hidden="true" />
          </summary>
          <p>
            These are planned base prices before applicable taxes. INR and USD
            are fixed regional prices, not a live exchange rate. Hosted checkout
            shows the final total before payment. Missing products remain
            unavailable rather than starting an incorrect purchase.
          </p>
        </details>
      </div>
    </section>
  );
}
