import { useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate } from 'react-router';
import { api, fileUrl, HttpError, saveFile, session, type Photo } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import './sources.css';
import { SelectionInbox } from './selection-review';
import type { EventSelection } from '../../../../packages/shared/src/proofing';
import {
  DEFAULT_SELECTION_RULES,
  selectionCountHint,
  type SelectionCountRules,
} from '../../../../packages/shared/src/selection-rules';
import { SelectionRulesForm } from './selection-rules';

export function GalleryAccess({
  eventId,
  children,
}: {
  eventId: string;
  children: ReactNode;
}) {
  const account = useQuery({ queryKey: ['session'], queryFn: session });
  const access = useQuery({
    queryKey: ['gallery-access', eventId],
    queryFn: () =>
      api<{
        brandingName: string;
        accentColor: string;
        selectionRules?: SelectionCountRules | null;
      }>(`/public/events/${eventId}/access`),
    retry: false,
    enabled: Boolean(account.data),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      await api(`/public/events/${eventId}/unlock`, {
        method: 'POST',
        body: JSON.stringify({ passcode: form.get('passcode') }),
      });
      await access.refetch();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  if (account.isPending) return <Loading />;
  if (account.error) return <ErrorNote error={account.error} />;
  if (
    !account.data ||
    (access.error instanceof HttpError &&
      access.error.code === 'UNAUTHENTICATED')
  )
    return (
      <Navigate
        to={`/sign-in?returnTo=${encodeURIComponent(`/e/${eventId}`)}`}
        replace
      />
    );
  if (access.isPending) return <Loading />;
  if (
    access.error instanceof HttpError &&
    access.error.code === 'GALLERY_LOCKED'
  )
    return (
      <section className="wrap standalone">
        <p className="eyebrow">PRIVATE INVITATION</p>
        <h1>This gallery has a passcode.</h1>
        <p>
          You are signed in. Enter the extra passcode provided by your
          organizer. No event purchase is required.
        </p>
        <form className="form-panel" onSubmit={(event) => void unlock(event)}>
          <label>
            Gallery passcode
            <input
              name="passcode"
              type="password"
              autoComplete="off"
              maxLength={64}
              required
            />
          </label>
          <button className="button" disabled={busy}>
            {busy ? 'Unlocking...' : 'Unlock gallery'}
          </button>
          <ErrorNote error={error} />
        </form>
      </section>
    );
  if (access.error)
    return (
      <section className="wrap standalone">
        <ErrorNote error={access.error} />
        <button
          className="button secondary"
          onClick={() => void access.refetch()}
        >
          Try again
        </button>
      </section>
    );
  return (
    <div
      style={{
        borderTop: `4px solid ${access.data?.accentColor ?? '#173f37'}`,
      }}
    >
      {access.data?.brandingName && (
        <p className="wrap eyebrow">
          PHOTOGRAPHY BY {access.data.brandingName}
        </p>
      )}
      {children}
      <GuestSelections
        key={eventId}
        eventId={eventId}
        rules={
          access.data?.selectionRules === null
            ? null
            : (access.data?.selectionRules ?? DEFAULT_SELECTION_RULES)
        }
        refreshRules={async () => {
          const result = await access.refetch();
          if (result.error) throw result.error;
        }}
      />
    </div>
  );
}
function GuestSelections({
  eventId,
  rules,
  refreshRules,
}: {
  eventId: string;
  rules: SelectionCountRules | null;
  refreshRules: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const photos = useQuery({
    queryKey: ['selection-photos', eventId],
    queryFn: () => api<{ photos: Photo[] }>(`/public/events/${eventId}`),
    enabled: open,
    retry: false,
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<unknown>(null);
  async function refreshPolicy() {
    setBusy(true);
    setError(null);
    try {
      await refreshRules();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage('');
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<{ message: string }>(
        `/public/events/${eventId}/selections`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: form.get('name'),
            note: form.get('note'),
            photoIds: selected,
          }),
        },
      );
      setMessage(result.message);
      setSelected([]);
    } catch (failure) {
      setError(failure);
      if (
        failure instanceof HttpError &&
        (failure.code === 'SELECTION_COUNT_REQUIRED' ||
          failure.code === 'SELECTION_RULES_INVALID')
      )
        await refreshRules().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  if (!rules)
    return (
      <section className="wrap">
        <div className="source-panel">
          <h2>Favorites submissions are paused.</h2>
          <p>
            You can still view the gallery. The photographer needs to repair
            this event selection policy before accepting requests.
          </p>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void refreshPolicy()}
          >
            Refresh selection limits
          </button>
          <ErrorNote error={error} />
        </div>
      </section>
    );
  return (
    <section className="wrap">
      <div className="source-panel">
        <h2>Send favorites to your photographer.</h2>
        <p>
          Choose photos from the full event gallery for edits or an album. Your
          name, note and chosen photo IDs will be visible to the organizer. No
          email or selfie is shared.
        </p>
        <button className="button secondary" onClick={() => setOpen(!open)}>
          {open ? 'Hide photo selection' : 'Choose favorites for organizer'}
        </button>
        {open && (
          <form onSubmit={(event) => void submit(event)}>
            <ErrorNote error={photos.error ?? error} />
            <div className="source-list">
              {photos.data?.photos.map((photo) => (
                <label key={photo.id}>
                  <input
                    type="checkbox"
                    disabled={
                      busy ||
                      (selected.length >= rules.maximum &&
                        !selected.includes(photo.id))
                    }
                    checked={selected.includes(photo.id)}
                    onChange={(event) =>
                      setSelected((previous) =>
                        event.target.checked
                          ? [...previous, photo.id]
                          : previous.filter((id) => id !== photo.id),
                      )
                    }
                  />
                  <img
                    src={fileUrl(photo.id, eventId)}
                    alt=""
                    width={48}
                    height={48}
                    loading="lazy"
                    style={{ objectFit: 'cover', borderRadius: 6 }}
                  />
                  {photo.filename}
                </label>
              ))}
            </div>
            <p className="field-help">
              {selected.length} selected. This request requires{' '}
              {rules.minimum === rules.maximum
                ? `exactly ${rules.minimum}`
                : `${rules.minimum} to ${rules.maximum}`}{' '}
              favorites.
            </p>
            <p role="status">{selectionCountHint(selected.length, rules)}</p>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => void refreshPolicy()}
            >
              Refresh selection limits
            </button>
            <label>
              Your name
              <input name="name" maxLength={100} required />
            </label>
            <label>
              Note for the organizer
              <textarea name="note" maxLength={500} />
            </label>
            <button
              className="button"
              disabled={
                busy ||
                selected.length < rules.minimum ||
                selected.length > rules.maximum
              }
            >
              {busy ? 'Sending...' : `Send ${selected.length} favorites`}
            </button>
            <p role="status">{message}</p>
          </form>
        )}
      </div>
    </section>
  );
}
type Insights = {
  photos: number;
  indexed: number;
  storageBytes: number;
  submissions: number;
  hasPasscode: boolean;
  brandingName: string;
  accentColor: string;
  selections: EventSelection[];
  selectionRules?: SelectionCountRules;
};
export function OrganizerTools({ eventId }: { eventId: string }) {
  const client = useQueryClient();
  const insights = useQuery({
    queryKey: ['event-insights', eventId],
    queryFn: () => api<Insights>(`/events/${eventId}/insights`),
    retry: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const passcode = String(form.get('passcode') ?? '');
    try {
      await api(`/events/${eventId}/presentation`, {
        method: 'PATCH',
        body: JSON.stringify({
          brandingName: form.get('brandingName'),
          accentColor: form.get('accentColor'),
          ...(form.get('removePasscode')
            ? { passcode: '' }
            : passcode
              ? { passcode }
              : {}),
        }),
      });
      setMessage(
        'Gallery presentation saved. Changing the passcode revokes previous gallery unlocks.',
      );
      await insights.refetch();
      await client.invalidateQueries({ queryKey: ['gallery-access', eventId] });
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function downloadCsv() {
    setError(null);
    try {
      const response = await fetch(
        `/api/events/${eventId}/insights?format=csv`,
        { credentials: 'include' },
      );
      if (!response.ok)
        throw new Error('Could not download the selection report.');
      saveFile(await response.blob(), 'photo-selections.csv');
    } catch (failure) {
      setError(failure);
    }
  }
  return (
    <section className="source-panel">
      <h2>Gallery presentation and client selections</h2>
      <ErrorNote error={insights.error ?? error} />
      {insights.data && (
        <>
          <p>
            {insights.data.photos} photos / {insights.data.indexed} searchable /{' '}
            {(insights.data.storageBytes / 1024 / 1024).toFixed(1)} MB stored /{' '}
            {insights.data.submissions} selection submissions
          </p>
          <form onSubmit={(event) => void save(event)}>
            <label>
              Photography or studio name
              <input
                name="brandingName"
                maxLength={100}
                defaultValue={insights.data.brandingName}
              />
            </label>
            <label>
              Gallery accent color
              <input
                name="accentColor"
                type="color"
                defaultValue={insights.data.accentColor}
              />
            </label>
            <label>
              {insights.data.hasPasscode
                ? 'Replace gallery passcode (leave blank to keep it)'
                : 'Gallery passcode (optional)'}
              <input
                name="passcode"
                type="password"
                minLength={6}
                maxLength={64}
                autoComplete="new-password"
              />
            </label>
            {insights.data.hasPasscode && (
              <label className="check-label">
                <input name="removePasscode" type="checkbox" />
                Remove the passcode requirement
              </label>
            )}
            <p className="field-help">
              A passcode protects gallery access, not copies already downloaded.
              Share it separately from the event link.
            </p>
            <button className="button secondary" disabled={busy}>
              Save presentation
            </button>
            <p role="status">{message}</p>
          </form>
          <div className="source-actions">
            <button
              className="button secondary"
              onClick={() => void insights.refetch()}
            >
              Refresh selections
            </button>
            <button
              className="button secondary"
              onClick={() => void downloadCsv()}
            >
              Export selections CSV
            </button>
          </div>
          <SelectionRulesForm
            key={eventId}
            eventId={eventId}
            rules={insights.data.selectionRules ?? DEFAULT_SELECTION_RULES}
            refresh={async () => {
              const result = await insights.refetch();
              if (result.error) throw result.error;
            }}
          />
          <SelectionInbox
            eventId={eventId}
            selections={insights.data.selections}
            refresh={async () => {
              const result = await insights.refetch();
              if (result.error) throw result.error;
              return result.data?.selections ?? [];
            }}
          />
        </>
      )}
    </section>
  );
}
