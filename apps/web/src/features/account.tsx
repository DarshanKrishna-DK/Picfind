import { useState, type FormEvent } from 'react';
import { AccountDialog, EmailConfirmation } from './account-dialog';
import './account.css';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowUpRight } from 'lucide-react';
import { api, saveFile, session } from '../api';
import { useLibrary } from '../hooks';
import { ErrorNote, PageTitle } from '../components/ui';
import { useAccountAction, useAccountCapabilities } from './account-actions';

export function SettingsPage() {
  const account = useQuery({ queryKey: ['session'], queryFn: session });
  const library = useLibrary();
  const capabilities = useAccountCapabilities();
  const action = useAccountAction();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<
    'password' | 'delete' | 'sessions' | null
  >(null);
  async function submit(
    event: FormEvent<HTMLFormElement>,
    kind: 'profile' | 'password' | 'delete',
  ) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const succeeded = await action.run(
      async () => {
        if (kind === 'profile') {
          await api('/account/profile', {
            method: 'PATCH',
            body: JSON.stringify({ name: String(fields.get('name')) }),
          });
          await client.invalidateQueries({ queryKey: ['session'] });
        } else if (kind === 'password') {
          if (fields.get('password') !== fields.get('confirmPassword'))
            throw new Error('The new passwords must match.');
          await api('/account/password', {
            method: 'POST',
            body: JSON.stringify({
              oldPassword: String(fields.get('oldPassword')),
              emailCode: String(fields.get('emailCode')),
              password: String(fields.get('password')),
            }),
          });
        } else {
          await api('/account', {
            method: 'DELETE',
            body: JSON.stringify({
              password: String(fields.get('password')),
              confirmation: String(fields.get('confirmation')),
              emailCode: String(fields.get('emailCode')),
            }),
          });
          client.clear();
          navigate('/sign-in', { replace: true });
        }
      },
      kind === 'profile'
        ? 'Your name has been updated.'
        : kind === 'password'
          ? 'Password updated and other sessions signed out.'
          : 'Account deleted.',
    );
    if (succeeded && kind === 'password') {
      form.reset();
      setDialog(null);
    }
  }
  return (
    <>
      <PageTitle eyebrow="YOUR SPACE, YOUR CHOICE" title="Account & privacy." />
      <ErrorNote error={account.error ?? capabilities.error ?? action.error} />
      <p role="status" aria-live="polite">
        {action.message}
      </p>
      <div className="settings-panel">
        <h2>Your account</h2>
        <dl>
          <div>
            <dt>Name</dt>
            <dd>{account.data?.name}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{account.data?.email}</dd>
          </div>
          <div>
            <dt>Email verification</dt>
            <dd>{account.data?.emailVerified ? 'Verified' : 'Not verified'}</dd>
          </div>
        </dl>
        {account.data && (
          <form
            key={account.data.id}
            onSubmit={(event) => void submit(event, 'profile')}
          >
            <label>
              Your name
              <input
                name="name"
                autoComplete="name"
                defaultValue={account.data.name}
                required
                maxLength={128}
              />
            </label>
            <button className="button secondary" disabled={action.busy}>
              Save name
            </button>
          </form>
        )}
        {!account.data?.emailVerified && capabilities.data?.verification && (
          <p>
            <button
              className="button secondary"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await api('/account/verification', { method: 'POST' });
                }, 'Check your inbox for the verification link.')
              }
            >
              Send verification email
            </button>
          </p>
        )}
      </div>
      <div className="settings-panel">
        <h2>Password & sessions</h2>
        <p>
          Changing your password also signs out other sessions. If you joined
          through Google and have no password, use password recovery first.
        </p>
        <button
          className="button secondary"
          onClick={(event) => {
            event.currentTarget.focus();
            setDialog('password');
          }}
        >
          Change password
        </button>
        {dialog === 'password' && (
          <AccountDialog
            title="Change password"
            busy={action.busy}
            close={() => setDialog(null)}
          >
            {capabilities.data?.recovery && (
              <p>
                Joined with Google or forgot your password?{' '}
                <Link className="text-link" to="/forgot-password">
                  Set or recover your password by email
                </Link>
                . Recovery signs out existing sessions; sign in again afterward.
              </p>
            )}
            <form onSubmit={(event) => void submit(event, 'password')}>
              <label>
                Current password
                <input
                  name="oldPassword"
                  type="password"
                  autoComplete="current-password"
                  required
                  minLength={8}
                  maxLength={256}
                />
              </label>
              <div className="form-pair">
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
              </div>
              <EmailConfirmation busy={action.busy} />
              <ErrorNote error={action.error} />
              <button className="button" disabled={action.busy}>
                Change password
              </button>
            </form>
          </AccountDialog>
        )}
        <p>
          <Link className="text-link" to="/forgot-password">
            Password recovery
          </Link>
        </p>
        <button
          className="button secondary"
          disabled={action.busy && dialog !== 'sessions'}
          onClick={(event) => {
            event.currentTarget.focus();
            setDialog('sessions');
          }}
        >
          Sign out other sessions
        </button>
        {dialog === 'sessions' && (
          <AccountDialog
            title="Sign out other devices?"
            busy={action.busy}
            close={() => setDialog(null)}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void action
                  .run(async () => {
                    await api('/account/sessions/others', { method: 'DELETE' });
                  }, 'Other sessions have been signed out. This device is still signed in.')
                  .then((succeeded) => {
                    if (succeeded) setDialog(null);
                  });
              }}
            >
              <p>
                Other browsers and devices signed in to PicFind will need to
                sign in again. This device stays signed in. Your photos, events
                and connected cloud sources will not be deleted.
              </p>
              <ErrorNote error={action.error} />
              <button className="button" disabled={action.busy}>
                {action.busy
                  ? 'Signing out other devices...'
                  : 'Confirm sign out other devices'}
              </button>
            </form>
          </AccountDialog>
        )}
      </div>
      <div className="settings-panel">
        <h2>Your library data</h2>
        <p>
          Download a record of your event details and photograph metadata. Photo
          files are downloaded from your library.
        </p>
        <button
          className="button secondary"
          disabled={!library.data}
          onClick={() =>
            saveFile(
              new Blob([JSON.stringify(library.data, null, 2)], {
                type: 'application/json',
              }),
              'picfind-library.json',
            )
          }
        >
          <ArrowDownToLine size={17} />
          Export library data
        </button>
        <ErrorNote error={library.error} />
      </div>
      <div className="settings-panel">
        <h2>Photo privacy</h2>
        <p>
          Uploaded files are re-encoded as JPEG images. Embedded location and
          camera metadata are removed. Your photos are private until you enable
          event link sharing.
        </p>
        <p>
          Delete individual photos from the photo viewer, or delete an event and
          its photos from event settings. Stored photos follow the retention
          period shown for their event or scan.
        </p>
        <Link className="text-link" to="/privacy">
          Read the privacy information <ArrowUpRight size={17} />
        </Link>
      </div>
      {capabilities.data?.deletion && (
        <div className="settings-panel danger-zone">
          <h2>Delete your account</h2>
          <p>
            This permanently removes your account, event galleries, stored
            photographs and import records. Shared galleries are disabled first.
            Export anything you want to keep before continuing. Active
            subscriptions and unresolved checkouts must be resolved first in
            Billing. Deleting this account does not request a payment refund;
            required billing records are retained separately.
          </p>
          <p>
            <Link className="text-link" to="/app/billing">
              Manage billing before deletion
            </Link>
          </p>
          <button
            className="button danger-outline"
            onClick={(event) => {
              event.currentTarget.focus();
              setDialog('delete');
            }}
          >
            Delete account
          </button>
          {dialog === 'delete' && (
            <AccountDialog
              title="Permanently delete account?"
              busy={action.busy}
              close={() => setDialog(null)}
            >
              <p>
                This cannot be undone. Your galleries and stored photographs
                will be removed. Export anything you want to keep first.
              </p>
              {capabilities.data?.recovery && (
                <p>
                  Joined with Google and have no password?{' '}
                  <Link className="text-link" to="/forgot-password">
                    Set a password by email first
                  </Link>
                  , then sign in again and return here to confirm deletion.
                </p>
              )}
              <form onSubmit={(event) => void submit(event, 'delete')}>
                <label>
                  Current password to delete account
                  <input
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    minLength={8}
                    maxLength={256}
                  />
                </label>
                <label>
                  Type DELETE to confirm
                  <input
                    name="confirmation"
                    autoComplete="off"
                    required
                    pattern="DELETE"
                  />
                </label>
                <EmailConfirmation busy={action.busy} />
                <ErrorNote error={action.error} />
                <button
                  className="button danger-outline"
                  disabled={action.busy}
                >
                  Permanently delete account
                </button>
              </form>
            </AccountDialog>
          )}
        </div>
      )}
    </>
  );
}
