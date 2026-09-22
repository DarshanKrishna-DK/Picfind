import { describe, expect, it } from 'vitest';
import { developmentStorageConfig } from '../../scripts/storage-test-config.js';

const allowed = {
  APPWRITE_ENDPOINT: 'https://fra.cloud.appwrite.io/v1',
  APPWRITE_PROJECT_ID: 'picfind-development',
  APPWRITE_API_KEY: 'synthetic-not-a-real-key',
};

describe('metadata diagnostic destination guard, no network calls', () => {
  it.each(['', '/'])(
    'accepts only the development endpoint with suffix %s',
    (suffix) => {
      expect(
        developmentStorageConfig({
          ...allowed,
          APPWRITE_ENDPOINT: allowed.APPWRITE_ENDPOINT + suffix,
        }),
      ).toEqual({
        endpoint: allowed.APPWRITE_ENDPOINT,
        projectId: allowed.APPWRITE_PROJECT_ID,
        apiKey: allowed.APPWRITE_API_KEY,
      });
    },
  );

  it.each([
    { APPWRITE_PROJECT_ID: 'picfind-production' },
    { APPWRITE_PROJECT_ID: undefined },
    { APPWRITE_ENDPOINT: 'https://nyc.cloud.appwrite.io/v1' },
    { APPWRITE_ENDPOINT: 'http://fra.cloud.appwrite.io/v1' },
    {
      APPWRITE_ENDPOINT: 'https://fra.cloud.appwrite.io/v1?project=production',
    },
    { APPWRITE_ENDPOINT: 'https://fra.cloud.appwrite.io.evil.test/v1' },
    { APPWRITE_API_KEY: '' },
    { APPWRITE_API_KEY: '  ' },
    { APPWRITE_API_KEY: undefined },
  ])('rejects an unsafe or incomplete destination %j', (overrides) => {
    expect(() =>
      developmentStorageConfig({ ...allowed, ...overrides }),
    ).toThrow('restricted to PicFind Development');
  });

  it('does not include supplied credentials in the rejection', () => {
    const secret = 'synthetic-sensitive-value';
    let message = '';
    try {
      developmentStorageConfig({
        ...allowed,
        APPWRITE_ENDPOINT: `https://${secret}@fra.cloud.appwrite.io/v1`,
        APPWRITE_API_KEY: secret,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('restricted');
    expect(message).not.toContain(secret);
  });
});
