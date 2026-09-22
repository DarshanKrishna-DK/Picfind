import { environmentSchema } from './config.js';
import {
  PERSONAL_PLAN_IDS,
  ORGANIZER_PLAN_IDS,
  PAID_PLAN_IDS,
} from './billing/model.js';

export interface LaunchCheck {
  id: string;
  status: 'pass' | 'block' | 'manual';
  message: string;
}

/** Pure, offline checks. Never return configuration values or provider responses. */
export function checkLaunchConfig(env: NodeJS.ProcessEnv): LaunchCheck[] {
  const checks: LaunchCheck[] = [];
  const check = (id: string, ready: boolean, message: string) =>
    checks.push({ id, status: ready ? 'pass' : 'block', message });
  const manual = (id: string, message: string) =>
    checks.push({ id, status: 'manual', message });
  const effective = { ...env };
  if (!effective.FACE_PROVIDER)
    effective.FACE_PROVIDER =
      effective.REKOGNITION_ENABLED === 'true'
        ? (effective.FACE_MATCHING_PROVIDER ?? 'aws-rekognition')
        : (effective.FACE_MATCHING_PROVIDER ?? 'none');
  check(
    'runtime-schema',
    environmentSchema.safeParse(effective).success,
    'API environment must satisfy its startup schema. Values are intentionally withheld.',
  );
  check(
    'production-mode',
    env.NODE_ENV === 'production',
    'The deployed API must use NODE_ENV=production. Local development may intentionally differ.',
  );
  let publicOrigin = false;
  try {
    const url = new URL(env.WEB_ORIGIN ?? '');
    publicOrigin =
      url.protocol === 'https:' &&
      url.origin === env.WEB_ORIGIN &&
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      !/\.(localhost|test|invalid|example|local)$/.test(url.hostname);
  } catch {
    /* Report a fixed message, never the supplied URL. */
  }
  check(
    'public-origin',
    publicOrigin,
    'WEB_ORIGIN must be the selected public HTTPS origin, without credentials, path or query. DNS/TLS reachability is a separate gate.',
  );
  check(
    'appwrite-config',
    Boolean(
      env.APPWRITE_ENDPOINT && env.APPWRITE_PROJECT_ID && env.APPWRITE_API_KEY,
    ),
    'Appwrite endpoint, project and server API key must be configured. Presence does not verify access.',
  );
  check(
    'google-sign-in',
    env.GOOGLE_OAUTH_ENABLED !== 'false',
    'Google browser sign-in must be enabled; Appwrite OAuth setup is checked separately.',
  );
  check(
    'photo-matching',
    effective.FACE_PROVIDER === 'aws-rekognition',
    'Photograph matching must select the existing AWS Rekognition adapter.',
  );
  check(
    'production-face-namespace',
    Boolean(
      env.REKOGNITION_NAMESPACE &&
      !/(?:^|-)(dev|development|test)(?:-|$)/.test(env.REKOGNITION_NAMESPACE),
    ),
    'Use an explicit production Rekognition namespace separate from development/test collections.',
  );
  check(
    'durable-face-worker',
    env.JOB_WORKER_ENABLED !== 'false',
    'Durable face processing must not be disabled.',
  );
  check(
    'source-connections',
    env.SOURCE_CONNECTIONS_ENABLED === 'true',
    'Persistent source connections must be enabled for saved cloud imports.',
  );
  check(
    'source-encryption',
    /^[a-f\d]{64}$/i.test(env.SOURCE_COOKIE_KEY ?? ''),
    'SOURCE_COOKIE_KEY must be a stable 64-character hexadecimal secret; keep it in a secret manager.',
  );
  check(
    'cloud-import-worker',
    env.CLOUD_IMPORT_WORKER_ENABLED === 'true',
    'Saved cloud imports require CLOUD_IMPORT_WORKER_ENABLED=true.',
  );
  check(
    'drive-oauth',
    Boolean(env.GOOGLE_DRIVE_CLIENT_ID && env.GOOGLE_DRIVE_CLIENT_SECRET),
    'Drive OAuth needs its client ID and secret. It is separate from Google browser sign-in.',
  );
  for (const provider of ['DROPBOX', 'ONEDRIVE', 'BOX']) {
    const ready = Boolean(
      env[`${provider}_CLIENT_ID`] && env[`${provider}_CLIENT_SECRET`],
    );
    checks.push({
      id: provider.toLowerCase() + '-oauth',
      status: ready ? 'pass' : 'manual',
      message: `${provider} requires a configured OAuth application and successful callback/import acceptance before advertising availability.`,
    });
  }
  check(
    'billing-storage',
    env.BILLING_ENABLED === 'true',
    'Organizer entitlements and event import transactions require durable billing storage.',
  );
  check(
    'role-catalog',
    env.BILLING_ROLE_CATALOG_ENABLED === 'true',
    'The personal/organizer accounting rollout must be enabled only after acceptance.',
  );
  check(
    'live-payment-environment',
    env.DODO_PAYMENTS_ENVIRONMENT === 'live_mode',
    'A paid public launch needs a separately approved Dodo live environment. Keep TEST mode during acceptance.',
  );
  check(
    'billing-secrets',
    Boolean(env.DODO_PAYMENTS_API_KEY && env.DODO_WEBHOOK_SECRET),
    'Dodo API credentials and webhook signing secret must be configured for the selected environment.',
  );
  check(
    'live-approval',
    env.BILLING_LIVE_APPROVED === 'true' &&
      env.BILLING_ROLE_CATALOG_LIVE_APPROVED === 'true',
    'Both live billing approvals must follow provider acceptance; the preflight never grants approval.',
  );
  check(
    'checkout-activation',
    env.BILLING_CHECKOUT_ENABLED === 'true',
    'Checkout must be explicitly enabled for paid launch only after all payment acceptance gates pass.',
  );
  check(
    'billing-recovery',
    env.BILLING_RECONCILIATION_ENABLED === 'true',
    'Enable durable billing reconciliation after its storage/provider acceptance.',
  );
  const products: string[] = [];
  check(
    'plan-change-activation',
    [undefined, 'false', 'true'].includes(env.BILLING_PLAN_CHANGES_ENABLED) &&
      [undefined, 'false', 'true'].includes(
        env.BILLING_PLAN_CHANGES_LIVE_APPROVED,
      ) &&
      (env.BILLING_PLAN_CHANGES_ENABLED !== 'true' ||
        (env.BILLING_ENABLED === 'true' &&
          env.BILLING_RECONCILIATION_ENABLED === 'true' &&
          (env.DODO_PAYMENTS_ENVIRONMENT !== 'live_mode' ||
            env.BILLING_PLAN_CHANGES_LIVE_APPROVED === 'true'))),
    'Plan changes must remain disabled or have billing, reconciliation and separate live plan-change approval. Flags must be literal true/false.',
  );
  manual(
    'plan-change-acceptance',
    'Verify TEST scheduling, lost-response recovery, application at renewal and scheduled-change cancellation before enabling plan changes. Disabled controls are not evidence of feature acceptance.',
  );
  for (const plan of PAID_PLAN_IDS)
    for (const currency of ['INR', 'USD']) {
      const key = `DODO_PRODUCT_${plan.replaceAll('-', '_').toUpperCase()}_${currency}`;
      const value = env[key];
      const required = [...PERSONAL_PLAN_IDS, ...ORGANIZER_PLAN_IDS].some(
        (id) => id === plan,
      );
      if (required || value)
        check(
          key,
          Boolean(value && /^pdt_[A-Za-z0-9]+$/.test(value)),
          `${key} must map to its own product in the selected environment. Provider price/cadence verification is separate.`,
        );
      if (value) products.push(value);
    }
  check(
    'distinct-products',
    new Set(products).size === products.length,
    'Product mappings must not alias different plans or currencies, including legacy mappings.',
  );
  check(
    'folder-sync-storage',
    env.FOLDER_SYNC_STORAGE_ENABLED === 'true',
    'Private folder-sync metadata and cleanup must remain enabled while sync records exist.',
  );
  check(
    'folder-sync-feature',
    env.FOLDER_SYNC_ENABLED === 'true',
    'The advertised opt-in folder-sync feature requires explicit activation after source/billing acceptance.',
  );
  check(
    'retention-worker',
    env.NODE_ENV === 'production' || env.RETENTION_WORKER_ENABLED === 'true',
    'Retention cleanup must run; production starts it automatically.',
  );
  manual(
    'appwrite-acceptance',
    'Verify the GitHub Student organization/project, private table/index schemas, storage permissions, transactions, backups and Education resource entitlement.',
  );
  manual(
    'oauth-acceptance',
    'Verify production Appwrite login and each advertised source OAuth callback using real accounts, including sign-out and secret-event return paths.',
  );
  manual(
    'payment-acceptance',
    'Complete application TEST checkout/payment/webhook, renewal, cancellation, refund/dispute and historical attribution acceptance. Unpaid session creation is insufficient.',
  );
  manual(
    'matching-and-cost',
    'Verify AWS role access, bounded photograph matching, storage/delivery costs and plan economics. This command makes no AWS calls.',
  );
  manual(
    'deployment-and-legal',
    'Verify production routing, TLS, monitoring, restore/rollback, support contact and reviewed privacy/terms before launch.',
  );
  return checks;
}
