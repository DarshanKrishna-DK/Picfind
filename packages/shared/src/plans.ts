// Public purchase catalog. Personal and organizer credits never top each other up.
export const ORGANIZER_RETENTION_DAYS = {
  starter: 30,
  pro: 90,
  scale: 365,
} as const;
export const PERSONAL_RETENTION_DAYS = 30;
export type PlanScope = 'personal' | 'organizer';
export type BillingPeriod = 'monthly' | 'yearly';
export interface PhotoPlan {
  id: string;
  name: string;
  scope: PlanScope;
  cadence: 'once' | 'month' | 'year';
  inr: number;
  usd: number;
  photos: number;
  searches: number;
  storageGb: number;
  deliveryGb: number;
  retentionDays: number;
  liveEvents: number;
  recommended?: boolean;
}
export const PERSONAL_TRIAL = {
  id: 'preview',
  name: 'Personal trial',
  scope: 'personal',
  cadence: 'once',
  inr: 0,
  usd: 0,
  photos: 20,
  searches: 20,
  storageGb: 0.1,
  deliveryGb: 0.5,
  retentionDays: 7,
  liveEvents: 0,
} as const satisfies PhotoPlan;
export const PERSONAL_PLANS = [
  {
    id: 'personal-250',
    name: '250-photo pack',
    scope: 'personal',
    cadence: 'once',
    inr: 99,
    usd: 1.25,
    photos: 250,
    searches: 250,
    storageGb: 0.5,
    deliveryGb: 1.25,
    retentionDays: PERSONAL_RETENTION_DAYS,
    liveEvents: 0,
  },
  {
    id: 'personal-500',
    name: '500-photo pack',
    scope: 'personal',
    cadence: 'once',
    inr: 179,
    usd: 2.25,
    photos: 500,
    searches: 500,
    storageGb: 1,
    deliveryGb: 2.5,
    retentionDays: PERSONAL_RETENTION_DAYS,
    liveEvents: 0,
  },
  {
    id: 'personal-1000',
    name: '1,000-photo pack',
    scope: 'personal',
    cadence: 'once',
    inr: 299,
    usd: 3.75,
    photos: 1000,
    searches: 1000,
    storageGb: 2,
    deliveryGb: 5,
    retentionDays: PERSONAL_RETENTION_DAYS,
    liveEvents: 0,
    recommended: true,
  },
] as const satisfies readonly PhotoPlan[];
const ORGANIZER_TIERS = [
  {
    tier: 'starter',
    name: 'Starter',
    inr: 699,
    usd: 9,
    photos: 2500,
    searches: 500,
    storageGb: 10,
    deliveryGb: 10,
    liveEvents: 2,
  },
  {
    tier: 'pro',
    name: 'Pro',
    inr: 1999,
    usd: 25,
    photos: 10000,
    searches: 1500,
    storageGb: 50,
    deliveryGb: 25,
    liveEvents: 10,
    recommended: true,
  },
  {
    tier: 'scale',
    name: 'Scale',
    inr: 9999,
    usd: 125,
    photos: 50000,
    searches: 5000,
    storageGb: 250,
    deliveryGb: 100,
    liveEvents: 50,
  },
] as const;
export const ORGANIZER_PLANS: readonly PhotoPlan[] = ORGANIZER_TIERS.flatMap(
  (tier) =>
    (['monthly', 'yearly'] as const).map((period): PhotoPlan => ({
      ...tier,
      id: `organizer-${tier.tier}-${period}`,
      scope: 'organizer',
      cadence: period === 'monthly' ? 'month' : 'year',
      inr: tier.inr * (period === 'yearly' ? 10 : 1),
      usd: tier.usd * (period === 'yearly' ? 10 : 1),
      retentionDays: ORGANIZER_RETENTION_DAYS[tier.tier],
    })),
);
export const PHOTO_PLANS: readonly PhotoPlan[] = [
  PERSONAL_TRIAL,
  ...PERSONAL_PLANS,
  ...ORGANIZER_PLANS,
];
// Historical purchases retain their original contract, but are no longer advertised.
export const LEGACY_PHOTO_PLANS = [
  PERSONAL_TRIAL,
  {
    id: 'photo-pack',
    name: 'Photo pack (legacy)',
    cadence: 'once',
    inr: 299,
    usd: 5,
    photos: 1000,
    searches: 100,
    storageGb: 2,
    deliveryGb: 5,
    retentionDays: 30,
  },
  {
    id: 'creator',
    name: 'Creator (legacy)',
    cadence: 'month',
    inr: 699,
    usd: 10,
    photos: 2500,
    searches: 250,
    storageGb: 5,
    deliveryGb: 10,
    retentionDays: 30,
  },
  {
    id: 'studio',
    name: 'Studio (legacy)',
    cadence: 'month',
    inr: 1999,
    usd: 29,
    photos: 7500,
    searches: 750,
    storageGb: 15,
    deliveryGb: 25,
    retentionDays: 30,
  },
] as const;
export function catalogPlans(
  scope: PlanScope,
  period: BillingPeriod = 'monthly',
): readonly PhotoPlan[] {
  return scope === 'personal'
    ? PERSONAL_PLANS
    : ORGANIZER_PLANS.filter(
        (plan) => plan.cadence === (period === 'monthly' ? 'month' : 'year'),
      );
}
type Item = { plan: PhotoPlan; quantity: number };
function estimate(items: Item[], fits = true) {
  return {
    items,
    plan: items[0]!.plan,
    quantity: items[0]!.quantity,
    fits,
    inr: items.reduce((sum, item) => sum + item.plan.inr * item.quantity, 0),
    usd: items.reduce((sum, item) => sum + item.plan.usd * item.quantity, 0),
    capacity: items.reduce(
      (sum, item) => sum + item.plan.photos * item.quantity,
      0,
    ),
  };
}
export function estimatePlan(
  photos: number,
  organizer: boolean,
  currency: 'INR' | 'USD' = 'INR',
  period: BillingPeriod = 'monthly',
) {
  const count = Number.isFinite(photos)
    ? Math.min(100000, Math.max(0, Math.ceil(photos)))
    : 0;
  if (organizer) {
    const plans = catalogPlans('organizer', period);
    const plan = plans.find((item) => item.photos >= count) ?? plans.at(-1)!;
    return estimate([{ plan, quantity: 1 }], count <= plan.photos);
  }
  if (count <= PERSONAL_TRIAL.photos)
    return estimate([{ plan: PERSONAL_TRIAL, quantity: 1 }]);
  // Quarter-thousand units bound the price comparison to 400 cells.
  const units = Math.ceil(count / 250);
  const cost = (plan: PhotoPlan) =>
    Math.round(plan[currency === 'INR' ? 'inr' : 'usd'] * 100);
  const best: { cost: number; counts: number[] }[] = [
    { cost: 0, counts: [0, 0, 0] },
  ];
  for (let n = 1; n <= units; n++) {
    const candidates = PERSONAL_PLANS.map((plan, index) => {
      const previous = best[Math.max(0, n - plan.photos / 250)]!;
      const counts = [...previous.counts];
      counts[index] = counts[index]! + 1;
      return { cost: previous.cost + cost(plan), counts };
    });
    best[n] = candidates.reduce((a, b) => (a.cost <= b.cost ? a : b));
  }
  return estimate(
    PERSONAL_PLANS.flatMap((plan, index) =>
      best[units]!.counts[index]
        ? [{ plan, quantity: best[units]!.counts[index]! }]
        : [],
    ),
  );
}
