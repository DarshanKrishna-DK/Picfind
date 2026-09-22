import { Account, AppwriteException } from 'node-appwrite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppwriteAuthenticationProvider } from '../../apps/api/src/adapters/appwrite-auth.js';

const provider = new AppwriteAuthenticationProvider({
  endpoint: 'https://example.test/v1',
  projectId: 'synthetic',
  apiKey: 'synthetic',
});
afterEach(() => vi.restoreAllMocks());
describe('email action confirmation adapter', () => {
  const user = {
    id: 'existing-user',
    name: 'Person',
    email: 'person@example.test',
    emailVerified: true,
  };
  it('sends only to the existing account and never returns the token', async () => {
    const send = vi
      .spyOn(Account.prototype, 'createEmailToken')
      .mockResolvedValue({ secret: 'never-return-this' } as never);
    await expect(provider.sendActionCode(user)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith({ userId: user.id, email: user.email });
  });
  it('consumes the code and revokes the temporary session', async () => {
    const create = vi
      .spyOn(Account.prototype, 'createSession')
      .mockResolvedValue({ secret: 'temporary-proof' } as never);
    vi.spyOn(provider, 'getUser').mockResolvedValue(user);
    const logout = vi.spyOn(provider, 'logout').mockResolvedValue();
    await provider.verifyActionCode(user, '123456');
    expect(create).toHaveBeenCalledWith({ userId: user.id, secret: '123456' });
    expect(logout).toHaveBeenCalledWith('temporary-proof');
  });
  it('rejects another identity and still cleans up the proof session', async () => {
    vi.spyOn(Account.prototype, 'createSession').mockResolvedValue({
      secret: 'temporary-proof',
    } as never);
    vi.spyOn(provider, 'getUser').mockResolvedValue({
      ...user,
      id: 'wrong-user',
    });
    const logout = vi.spyOn(provider, 'logout').mockResolvedValue();
    await expect(
      provider.verifyActionCode(user, '123456'),
    ).rejects.toMatchObject({ code: 'REAUTH_FAILED' });
    expect(logout).toHaveBeenCalledWith('temporary-proof');
  });
  it('rejects expired or reused codes without creating proof', async () => {
    vi.spyOn(Account.prototype, 'createSession').mockRejectedValue(
      new AppwriteException('Invalid token', 401, 'user_invalid_token'),
    );
    const getUser = vi.spyOn(provider, 'getUser');
    await expect(
      provider.verifyActionCode(user, '123456'),
    ).rejects.toMatchObject({ status: 401 });
    expect(getUser).not.toHaveBeenCalled();
  });
});
describe('Appwrite session errors do not masquerade as provider outages', () => {
  it('treats an invalid session downgraded to guest permissions as unauthenticated', async () => {
    vi.spyOn(Account.prototype, 'get').mockRejectedValue(
      new AppwriteException(
        'Guest lacks account scope',
        401,
        'general_unauthorized_scope',
      ),
    );
    await expect(provider.getUser('revoked-session')).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    });
  });
  it('keeps API-key permission errors distinct from invalid user sessions', async () => {
    vi.spyOn(Account.prototype, 'create').mockRejectedValue(
      new AppwriteException(
        'Server key lacks scope',
        401,
        'general_unauthorized_scope',
      ),
    );
    await expect(
      provider.register({
        name: 'Synthetic',
        email: 'synthetic@example.test',
        password: 'synthetic-only-password',
      }),
    ).rejects.toMatchObject({ status: 503, code: 'AUTH_UNAVAILABLE' });
  });
  it('allows local logout of a session Appwrite has already invalidated', async () => {
    vi.spyOn(Account.prototype, 'deleteSession').mockRejectedValue(
      new AppwriteException(
        'Guest lacks account scope',
        401,
        'general_unauthorized_scope',
      ),
    );
    await expect(provider.logout('revoked-session')).resolves.toBeUndefined();
  });
});
