import {
  Account,
  AppwriteException,
  Client,
  ID,
  OAuthProvider,
  Query,
  Users,
} from 'node-appwrite';
import {
  ApiError,
  type AuthenticationProvider,
  type AuthUser,
} from '../auth.js';

export interface AppwriteAuthConfig {
  endpoint: string;
  projectId: string;
  apiKey: string;
}

function publicUser(user: {
  $id: string;
  name: string;
  email: string;
  emailVerification: boolean;
  status: boolean;
}): AuthUser {
  if (!user.status)
    throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in to continue.');
  return {
    id: user.$id,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerification,
  };
}

async function translate<T>(
  operation: () => Promise<T>,
  sessionRequest = false,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof AppwriteException) {
      if (
        error.code === 401 &&
        (sessionRequest || error.type !== 'general_unauthorized_scope')
      ) {
        throw new ApiError(
          401,
          'UNAUTHENTICATED',
          'The account credentials or session are not valid.',
        );
      }
      if (error.type === 'project_provider_disabled')
        throw new ApiError(
          503,
          'GOOGLE_UNAVAILABLE',
          'Google sign-in is not enabled yet. Use email sign-in while setup is completed.',
        );
      if (error.code === 429)
        throw new ApiError(
          429,
          'RATE_LIMITED',
          'Please wait before trying again.',
        );
      if (error.code === 409 || error.code === 400) {
        throw new ApiError(
          400,
          'ACCOUNT_REQUEST_REJECTED',
          'The account request could not be completed with these details.',
        );
      }
    }
    // Never expose Appwrite responses, credentials, tokens, or SDK request details.
    throw new ApiError(
      503,
      'AUTH_UNAVAILABLE',
      'The account service is temporarily unavailable.',
    );
  }
}

export class AppwriteAuthenticationProvider implements AuthenticationProvider {
  constructor(private readonly config: AppwriteAuthConfig) {}
  resolveEventMember(email: string) {
    return translate(async () => {
      const normalized = email.trim().toLowerCase();
      const client = new Client()
        .setEndpoint(this.config.endpoint)
        .setProject(this.config.projectId)
        .setKey(this.config.apiKey);
      const result = await new Users(client).list({
        queries: [Query.equal('email', normalized), Query.limit(2)],
      });
      const matches = result.users.filter(
        (user) =>
          user.email.toLowerCase() === normalized &&
          user.status &&
          user.emailVerification,
      );
      return matches.length === 1 ? publicUser(matches[0]!) : null;
    });
  }

  private account(session?: string) {
    // Per-request clients prevent one user's session from leaking into another request.
    const client = new Client()
      .setEndpoint(this.config.endpoint)
      .setProject(this.config.projectId);
    if (session) client.setSession(session);
    else client.setKey(this.config.apiKey);
    return new Account(client);
  }

  register(input: { name: string; email: string; password: string }) {
    return translate(async () =>
      publicUser(
        await this.account().create({ userId: ID.unique(), ...input }),
      ),
    );
  }

  login(input: { email: string; password: string }) {
    return translate(async () => {
      const session = await this.account().createEmailPasswordSession(input);
      return { secret: session.secret, expiresAt: session.expire };
    });
  }

  getUser(secret: string) {
    return translate(
      async () => publicUser(await this.account(secret).get()),
      true,
    );
  }

  async recover(email: string, url: string) {
    try {
      await this.account().createRecovery({ email, url });
    } catch (error) {
      if (error instanceof AppwriteException && error.code === 404) return;
      await translate(async () => {
        throw error;
      });
    }
  }
  async resetPassword(input: {
    userId: string;
    secret: string;
    password: string;
  }) {
    await translate(() => this.account().updateRecovery(input));
    // A recovered password must not leave an old stolen session active.
    const client = new Client()
      .setEndpoint(this.config.endpoint)
      .setProject(this.config.projectId)
      .setKey(this.config.apiKey);
    await translate(() =>
      new Users(client).deleteSessions({ userId: input.userId }),
    );
  }
  async sendVerification(secret: string, url: string) {
    await translate(
      () => this.account(secret).createVerification({ url }),
      true,
    );
  }
  async verifyEmail(input: { userId: string; secret: string }) {
    await translate(() => this.account().updateVerification(input));
  }
  updateName(secret: string, name: string) {
    return translate(
      async () => publicUser(await this.account(secret).updateName({ name })),
      true,
    );
  }
  async changePassword(secret: string, oldPassword: string, password: string) {
    await translate(
      () => this.account(secret).updatePassword({ password, oldPassword }),
      true,
    );
  }
  async revokeOtherSessions(secret: string) {
    const account = this.account(secret);
    const sessions = await translate(() => account.listSessions(), true);
    for (const session of sessions.sessions)
      if (!session.current)
        await translate(
          () => account.deleteSession({ sessionId: session.$id }),
          true,
        );
  }
  beginGoogle(success: string, failure: string) {
    return translate(() =>
      this.account().createOAuth2Token({
        provider: OAuthProvider.Google,
        success,
        failure,
      }),
    );
  }
  completeGoogle(userId: string, secret: string) {
    return translate(async () => {
      const session = await this.account().createSession({ userId, secret });
      return { secret: session.secret, expiresAt: session.expire };
    });
  }
  async deleteUser(userId: string) {
    const client = new Client()
      .setEndpoint(this.config.endpoint)
      .setProject(this.config.projectId)
      .setKey(this.config.apiKey);
    await translate(() => new Users(client).delete({ userId }));
  }

  async sendActionCode(user: AuthUser) {
    await translate(() =>
      this.account().createEmailToken({ userId: user.id, email: user.email }),
    );
  }

  async verifyActionCode(user: AuthUser, code: string) {
    await translate(async () => {
      const session = await this.account().createSession({
        userId: user.id,
        secret: code,
      });
      try {
        const confirmed = await this.getUser(session.secret);
        if (confirmed.id !== user.id || confirmed.email !== user.email)
          throw new ApiError(
            403,
            'REAUTH_FAILED',
            'Email confirmation failed.',
          );
      } finally {
        await this.logout(session.secret);
      }
    });
  }

  async logout(secret: string) {
    try {
      await translate(
        () => this.account(secret).deleteSession({ sessionId: 'current' }),
        true,
      );
    } catch (error) {
      // Already expired/revoked sessions are safely logged out; outages remain retryable.
      if (!(error instanceof ApiError && error.status === 401)) throw error;
    }
  }
}
