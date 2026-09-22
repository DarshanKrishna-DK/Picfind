import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api } from '../api';
import { ErrorNote } from '../components/ui';
import { useAccountAction } from './account-actions';

export function AccountDialog({
  title,
  busy,
  close,
  children,
}: {
  title: string;
  busy: boolean;
  close(): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const trigger = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="account-dialog"
      aria-labelledby="account-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <header>
        <h2 id="account-dialog-title">{title}</h2>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={close}
        >
          Close
        </button>
      </header>
      {children}
    </dialog>
  );
}

export function EmailConfirmation({ busy }: { busy: boolean }) {
  const action = useAccountAction();
  const [cooldown, setCooldown] = useState(false);
  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setTimeout(() => setCooldown(false), 60_000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);
  return (
    <div className="email-confirmation">
      <p>
        Confirm this action with the one-time code sent to your account email. A
        code can only be used once. If an action fails after verification,
        request a new code.
      </p>
      <button
        type="button"
        className="button secondary"
        disabled={busy || action.busy || cooldown}
        onClick={() =>
          void action.run(async () => {
            await api('/account/confirmation', { method: 'POST' });
            setCooldown(true);
          }, 'Code sent. Check your inbox and spam folder. Wait one minute before requesting another code.')
        }
      >
        {action.busy
          ? 'Sending...'
          : cooldown
            ? 'Code sent - check your email'
            : 'Send email code'}
      </button>
      <ErrorNote error={action.error} />
      <p role="status">{action.message}</p>
      <label>
        Email confirmation code
        <input
          name="emailCode"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          minLength={6}
          maxLength={6}
          required
        />
      </label>
    </div>
  );
}
