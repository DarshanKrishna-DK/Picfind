import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { ErrorNote, PageTitle } from '../components/ui';
import { useAccountAction } from './account-actions';

export function RecoveryPage({
  mode,
}: {
  mode: 'request' | 'reset' | 'verify';
}) {
  const action = useAccountAction();
  const location = useLocation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [completed, setCompleted] = useState(false);
  const [token] = useState(() => {
    const search = new URLSearchParams(location.search);
    return {
      userId: search.get('userId') ?? '',
      secret: search.get('secret') ?? '',
    };
  });
  useEffect(() => {
    // Keep email tokens out of copied URLs and subsequent navigation/referrers.
    if (location.search && mode !== 'request')
      navigate(location.pathname, { replace: true });
  }, [location.pathname, location.search, mode, navigate]);
  const validToken = Boolean(token.userId && token.secret);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const succeeded = await action.run(
      async () => {
        if (mode === 'request') {
          await api('/account/recovery', {
            method: 'POST',
            body: JSON.stringify({ email: String(data.get('email')) }),
          });
        } else if (mode === 'reset') {
          if (data.get('password') !== data.get('confirmPassword'))
            throw new Error('The new passwords must match.');
          await api('/account/reset-password', {
            method: 'POST',
            body: JSON.stringify({
              ...token,
              password: String(data.get('password')),
            }),
          });
          client.clear();
        } else {
          await api('/account/verify-email', {
            method: 'POST',
            body: JSON.stringify(token),
          });
          await client.invalidateQueries({ queryKey: ['session'] });
        }
      },
      mode === 'request'
        ? 'If that address has an account, a password reset email has been sent. Check your inbox and spam folder.'
        : mode === 'reset'
          ? 'Password updated. Sign in with your new password.'
          : 'Your email address is verified.',
    );
    if (succeeded) {
      form.reset();
      setCompleted(true);
    }
  }
  return (
    <section className="wrap standalone">
      <PageTitle
        eyebrow="ACCOUNT SECURITY"
        title={
          mode === 'request'
            ? 'Find your way back.'
            : mode === 'reset'
              ? 'A fresh password.'
              : 'Verify your email.'
        }
      />
      <div className="settings-panel">
        {mode !== 'request' && !validToken ? (
          <p role="alert">
            This link is incomplete.{' '}
            {mode === 'reset'
              ? 'Request a new password reset email.'
              : 'Open account settings to request a new verification email.'}
          </p>
        ) : (
          !completed && (
            <form onSubmit={(event) => void submit(event)}>
              {mode === 'request' && (
                <label>
                  Email address
                  <input
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    maxLength={320}
                  />
                </label>
              )}
              {mode === 'reset' && (
                <>
                  <label>
                    New password
                    <input
                      name="password"
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={8}
                      maxLength={256}
                    />
                  </label>
                  <label>
                    Confirm new password
                    <input
                      name="confirmPassword"
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={8}
                      maxLength={256}
                    />
                  </label>
                </>
              )}
              {mode === 'verify' && (
                <p>
                  Confirm that you want to verify the email address associated
                  with this link.
                </p>
              )}
              <button className="button" disabled={action.busy}>
                {action.busy
                  ? 'Please wait...'
                  : mode === 'request'
                    ? 'Send reset link'
                    : mode === 'reset'
                      ? 'Reset password'
                      : 'Verify email address'}
              </button>
            </form>
          )
        )}
        <ErrorNote error={action.error} />
        <p role="status">{action.message}</p>
        <div className="actions">
          <Link className="text-link" to="/sign-in">
            Return to sign in
          </Link>
          {mode === 'reset' && (
            <Link className="text-link" to="/forgot-password">
              Request a new link
            </Link>
          )}
          {mode === 'verify' && (
            <Link className="text-link" to="/app/settings">
              Account settings
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}
