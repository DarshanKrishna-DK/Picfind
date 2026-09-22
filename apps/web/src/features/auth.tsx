import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { api, session } from '../api';
import logo from '../assets/picfind-logo-small.webp';
import { studioReturnPath } from '../../../../packages/shared/src/navigation';
import { ErrorNote } from '../components/ui';
import { useAccountCapabilities } from './account-actions';

export function SignIn() {
  const capabilities = useAccountCapabilities();
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const navigate = useNavigate();
  const client = useQueryClient();
  const location = useLocation();
  const current = useQuery({ queryKey: ['session'], queryFn: session });
  const destination = studioReturnPath(
    (location.state as { returnTo?: string } | null)?.returnTo ??
      new URLSearchParams(location.search).get('returnTo'),
  );
  if (current.data) return <Navigate to={destination} replace />;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    const credentials = {
      email: String(form.get('email')),
      password: String(form.get('password')),
    };
    try {
      if (register)
        await api('/auth/register', {
          method: 'POST',
          body: JSON.stringify({
            ...credentials,
            name: String(form.get('name')),
          }),
        });
      await api('/auth/session', {
        method: 'POST',
        body: JSON.stringify(credentials),
      });
      client.clear();
      await client.fetchQuery({ queryKey: ['session'], queryFn: session });
      navigate(destination, {
        replace: true,
      });
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="auth-layout wrap">
      <div className="auth-aside">
        <p className="eyebrow">YOUR PERSONAL PHOTO SPACE</p>
        <h1>
          Back to
          <br />
          the good stuff.
        </h1>
        <img src={logo} alt="PicFind camera and photo stack" />
        <p>
          A little less searching.
          <br />A little more remembering.
        </p>
      </div>
      <div className="auth-form">
        <p className="eyebrow">WELCOME TO PICFIND</p>
        <h2>
          {register ? 'Make yourself at home.' : 'Your photos are waiting.'}
        </h2>
        <p>
          {register
            ? 'Create an account to start your private library.'
            : 'Sign in to open your photo library.'}
        </p>
        {new URLSearchParams(location.search).get('error') === 'google' && (
          <p role="alert">
            Google sign-in could not be completed. Please try again or use
            email.
          </p>
        )}
        <ErrorNote error={capabilities.error} />
        {capabilities.error && (
          <button
            className="text-link"
            onClick={() => void capabilities.refetch()}
          >
            Retry connection
          </button>
        )}
        <button
          className="button secondary full google-signin"
          disabled={busy || !capabilities.data?.google}
          onClick={() => {
            setBusy(true);
            setError(null);
            void api<{ url: string }>('/account/google', {
              method: 'POST',
              body: JSON.stringify({ returnTo: destination }),
            })
              .then(({ url }) => {
                window.location.assign(url);
              })
              .catch((failure: unknown) => {
                setError(failure);
                setBusy(false);
              });
          }}
        >
          <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="#4285f4"
              d="M21.6 12.2c0-.7-.1-1.4-.2-2.2H12v4.2h5.4a4.6 4.6 0 0 1-2 3v2.6h3.3c1.9-1.8 2.9-4.4 2.9-7.6Z"
            />
            <path
              fill="#34a853"
              d="M12 22c2.7 0 5-.9 6.7-2.4l-3.3-2.6c-.9.6-2 .9-3.4.9-2.6 0-4.9-1.8-5.7-4.1H2.9v2.7A10.1 10.1 0 0 0 12 22Z"
            />
            <path
              fill="#fbbc05"
              d="M6.3 13.8a6 6 0 0 1 0-3.6V7.5H2.9a10 10 0 0 0 0 9l3.4-2.7Z"
            />
            <path
              fill="#ea4335"
              d="M12 6.1c1.5 0 2.8.5 3.8 1.5l2.9-2.9A9.7 9.7 0 0 0 12 2a10.1 10.1 0 0 0-9.1 5.5l3.4 2.7C7.1 7.9 9.4 6.1 12 6.1Z"
            />
          </svg>
          Continue with Google
        </button>
        {!capabilities.isPending &&
          !capabilities.error &&
          !capabilities.data?.google && (
            <p className="field-help">
              Google sign-in is not enabled on this installation. You can use
              email below.
            </p>
          )}
        <div className="auth-divider">
          <span>or use your email</span>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          {register && (
            <label>
              Your name
              <input name="name" autoComplete="name" required maxLength={128} />
            </label>
          )}
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
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete={register ? 'new-password' : 'current-password'}
              required
              minLength={8}
              maxLength={256}
            />
          </label>
          {register && (
            <p className="field-help">
              Use at least 8 characters. By creating an account, you acknowledge
              the <Link to="/privacy">privacy information</Link> and{' '}
              <Link to="/terms">terms</Link>.
            </p>
          )}
          <ErrorNote error={error} />
          <button className="button full" disabled={busy}>
            {busy ? 'Please wait...' : register ? 'Create account' : 'Sign in'}
            <ArrowRight size={18} />
          </button>
        </form>
        {!register && capabilities.data?.recovery && (
          <p>
            <Link className="text-link" to="/forgot-password">
              Forgot password?
            </Link>
          </p>
        )}
        <button
          className="text-link auth-toggle"
          onClick={() => {
            setRegister(!register);
            setError(null);
          }}
          disabled={busy}
        >
          {register
            ? 'Already have an account? Sign in'
            : 'New here? Create an account'}
        </button>
      </div>
    </section>
  );
}
