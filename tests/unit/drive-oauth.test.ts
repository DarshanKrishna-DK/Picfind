import { describe, expect, it } from 'vitest';
import { beginDriveAuthorization } from '../../apps/api/src/drive-oauth';

describe('Google Drive user OAuth', () => {
  it('requests drive.readonly with an offline grant', () => {
    const url = new URL(
      beginDriveAuthorization(
        {
          clientId: 'client.apps.googleusercontent.com',
          clientSecret: 'secret',
          webOrigin: 'http://localhost:5173',
          secureCookies: false,
        },
        'state-token',
      ),
    );
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/drive.readonly',
    );
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:5173/api/drive/callback',
    );
    expect(url.searchParams.get('state')).toBe('state-token');
  });
});
