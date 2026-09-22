import { describe, expect, it } from 'vitest';
import { syncFolderId } from '../../apps/web/src/features/event-folder-syncs.js';

describe('selected sync folder normalization', () => {
  it('normalizes a browsed Google Drive folder link without sending the full URL', () => {
    expect(
      syncFolderId(
        'drive',
        'https://drive.google.com/drive/folders/photo-folder?usp=sharing',
      ),
    ).toBe('photo-folder');
    expect(
      syncFolderId(
        'drive',
        'https://drive.google.com/drive/u/0/folders/photo-folder',
      ),
    ).toBe('photo-folder');
    expect(syncFolderId('drive', 'photo-folder')).toBe('photo-folder');
  });
  it('rejects unrelated hosts and insecure Drive URLs', () => {
    expect(
      syncFolderId('drive', 'https://example.test/drive/folders/photo-folder'),
    ).toBeNull();
    expect(
      syncFolderId(
        'drive',
        'http://drive.google.com/drive/folders/photo-folder',
      ),
    ).toBeNull();
  });
  it.each(['drive', 'dropbox', 'box', 'onedrive'] as const)(
    'does not permit the %s account root',
    (provider) => {
      for (const root of ['', 'root', '/'])
        expect(syncFolderId(provider, root)).toBeNull();
    },
  );
});
