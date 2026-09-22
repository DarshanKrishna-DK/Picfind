import type { BillingService } from './service.js';
import type { BillingScope } from './model.js';

export type ProductScope = 'personal' | 'organizer';

/** Only server-derived collection context may be passed here, never request input.
 * Keep historical accounting intact while the role catalog rollout is closed.
 */
export function productBillingScope(
  billing: BillingService | undefined,
  context: ProductScope,
): BillingScope {
  return billing?.roleCatalogEnabled ? context : 'legacy';
}
