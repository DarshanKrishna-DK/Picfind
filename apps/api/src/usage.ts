import { ApiError } from './auth.js';
import type { BillingService } from './billing/service.js';
import type { LibraryStore } from './library.js';
import { reserveProcessing } from './processing-budget.js';
import {
  productBillingScope,
  type ProductScope,
} from './billing/product-scope.js';

export async function reserveFaceUsage(
  store: LibraryStore,
  billing: BillingService | undefined,
  ownerId: string,
  operation: 'index' | 'search',
  context: ProductScope,
) {
  if (process.env.NODE_ENV === 'production') {
    if (!billing)
      throw new ApiError(
        503,
        'USAGE_ACCOUNTING_UNAVAILABLE',
        'Photo processing is paused until usage accounting is configured.',
      );
  } else {
    // Keep pre-launch developer spending bounded, independently of plan allowances.
    await reserveProcessing(store, ownerId, operation);
  }
  await billing?.reserve(
    ownerId,
    operation,
    1,
    undefined,
    productBillingScope(billing, context),
  );
}
