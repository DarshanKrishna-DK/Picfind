import { describe, expect, it } from 'vitest';
import { checkLaunchConfig } from '../../apps/api/src/launch-config.js';
import {
  PERSONAL_PLAN_IDS,
  ORGANIZER_PLAN_IDS,
} from '../../apps/api/src/billing/model.js';

function fixture(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    WEB_ORIGIN: 'https://photos.picfind.app',
    APPWRITE_ENDPOINT: 'https://fra.cloud.appwrite.io/v1',
    APPWRITE_PROJECT_ID: 'synthetic',
    APPWRITE_API_KEY: 'PRIVATE_SENTINEL',
    FACE_PROVIDER: 'aws-rekognition',
    AWS_REGION: 'ap-south-1',
    REKOGNITION_MATCH_THRESHOLD: '80',
    REKOGNITION_NAMESPACE: 'picfind-production',
    SOURCE_CONNECTIONS_ENABLED: 'true',
    SOURCE_COOKIE_KEY: 'a'.repeat(64),
    CLOUD_IMPORT_WORKER_ENABLED: 'true',
    GOOGLE_DRIVE_CLIENT_ID: 'synthetic',
    GOOGLE_DRIVE_CLIENT_SECRET: 'PRIVATE_SENTINEL',
    BILLING_ENABLED: 'true',
    BILLING_ROLE_CATALOG_ENABLED: 'true',
    DODO_PAYMENTS_ENVIRONMENT: 'live_mode',
    DODO_PAYMENTS_API_KEY: 'PRIVATE_SENTINEL',
    DODO_WEBHOOK_SECRET: 'PRIVATE_SENTINEL',
    BILLING_LIVE_APPROVED: 'true',
    BILLING_ROLE_CATALOG_LIVE_APPROVED: 'true',
    BILLING_CHECKOUT_ENABLED: 'true',
    BILLING_RECONCILIATION_ENABLED: 'true',
    FOLDER_SYNC_STORAGE_ENABLED: 'true',
    FOLDER_SYNC_ENABLED: 'true',
  };
  for (const plan of [...PERSONAL_PLAN_IDS, ...ORGANIZER_PLAN_IDS])
    for (const currency of ['INR', 'USD'])
      env[
        `DODO_PRODUCT_${plan.replaceAll('-', '_').toUpperCase()}_${currency}`
      ] = `pdt_${plan.replaceAll('-', '')}${currency}`;
  return env;
}
describe('offline launch configuration reporting', () => {
  it.each([
    { BILLING_PLAN_CHANGES_ENABLED: 'TRUE' },
    { BILLING_PLAN_CHANGES_ENABLED: 'true' },
    {
      BILLING_PLAN_CHANGES_ENABLED: 'true',
      BILLING_PLAN_CHANGES_LIVE_APPROVED: 'true',
      BILLING_RECONCILIATION_ENABLED: 'false',
    },
  ])('reports unsafe plan-change activation without enabling it', (flags) => {
    const env = { ...fixture(), ...flags };
    expect(
      checkLaunchConfig(env).find(
        (check) => check.id === 'plan-change-activation',
      )?.status,
    ).toBe('block');
  });
  it('keeps provider lifecycle acceptance separate from valid plan-change flags', () => {
    const result = checkLaunchConfig({
      ...fixture(),
      BILLING_PLAN_CHANGES_ENABLED: 'true',
      BILLING_PLAN_CHANGES_LIVE_APPROVED: 'true',
    });
    expect(
      result.find((check) => check.id === 'plan-change-activation')?.status,
    ).toBe('pass');
    expect(
      result.find((check) => check.id === 'plan-change-acceptance')?.status,
    ).toBe('manual');
  });
  it('never equates valid configuration with verified external readiness', () => {
    const result = checkLaunchConfig(fixture());
    expect(result.filter((check) => check.status === 'block')).toEqual([]);
    expect(
      result.find((check) => check.id === 'payment-acceptance')?.status,
    ).toBe('manual');
    expect(
      result.find((check) => check.id === 'oauth-acceptance')?.status,
    ).toBe('manual');
  });
  it('reports absent configuration without crashing or enabling anything', () => {
    const env = {};
    expect(
      checkLaunchConfig(env).some((check) => check.status === 'block'),
    ).toBe(true);
    expect(env).toEqual({});
  });
  it('never includes credentials or configured endpoint values in output', () => {
    const env = {
      ...fixture(),
      WEB_ORIGIN: 'https://PRIVATE_SENTINEL:PRIVATE_SENTINEL@example.test',
      SOURCE_COOKIE_KEY: 'PRIVATE_SENTINEL',
    };
    expect(JSON.stringify(checkLaunchConfig(env))).not.toContain(
      'PRIVATE_SENTINEL',
    );
    expect(
      checkLaunchConfig(env).find((check) => check.id === 'public-origin')
        ?.status,
    ).toBe('block');
  });
  it('rejects a test catalog as paid production readiness', () => {
    const env = {
      ...fixture(),
      DODO_PAYMENTS_ENVIRONMENT: 'test_mode',
      BILLING_CHECKOUT_ENABLED: 'false',
    };
    const result = checkLaunchConfig(env);
    for (const id of ['live-payment-environment', 'checkout-activation'])
      expect(result.find((check) => check.id === id)?.status).toBe('block');
  });
  it('reports missing and aliased current product mappings', () => {
    const env = fixture();
    delete env.DODO_PRODUCT_PERSONAL_250_INR;
    env.DODO_PRODUCT_PERSONAL_500_INR = env.DODO_PRODUCT_PERSONAL_500_USD;
    const result = checkLaunchConfig(env);
    expect(
      result.find((check) => check.id === 'DODO_PRODUCT_PERSONAL_250_INR')
        ?.status,
    ).toBe('block');
    expect(
      result.find((check) => check.id === 'distinct-products')?.status,
    ).toBe('block');
  });
  it('reports disabled workers and incomplete source credentials', () => {
    const env = {
      ...fixture(),
      CLOUD_IMPORT_WORKER_ENABLED: 'false',
      GOOGLE_DRIVE_CLIENT_SECRET: '',
      JOB_WORKER_ENABLED: 'false',
    };
    const result = checkLaunchConfig(env);
    for (const id of [
      'cloud-import-worker',
      'drive-oauth',
      'durable-face-worker',
    ])
      expect(result.find((check) => check.id === id)?.status).toBe('block');
  });
  it('matches the existing face-provider alias without mutating the environment', () => {
    const env = fixture();
    delete env.FACE_PROVIDER;
    env.FACE_MATCHING_PROVIDER = 'aws-rekognition';
    expect(
      checkLaunchConfig(env).find((check) => check.id === 'photo-matching')
        ?.status,
    ).toBe('pass');
    expect(env.FACE_PROVIDER).toBeUndefined();
  });
  it('requires an explicit non-development face namespace', () => {
    const env = { ...fixture(), REKOGNITION_NAMESPACE: 'picfind-development' };
    expect(
      checkLaunchConfig(env).find(
        (check) => check.id === 'production-face-namespace',
      )?.status,
    ).toBe('block');
  });
});
