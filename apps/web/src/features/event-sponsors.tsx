import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, HttpError, session } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import {
  SPONSOR_ACTOR,
  SPONSOR_LIMIT,
  SPONSOR_PERMISSION,
  sponsorCommand,
  sponsorState,
  type SponsorFields,
  type SponsorState,
  type PublishedSponsors,
} from '../../../../packages/shared/src/event-sponsors';
import './event-sponsors.css';

export function SponsorCredits({
  sponsors,
  placement,
}: {
  sponsors: PublishedSponsors | undefined;
  placement: 'gallery' | 'wall';
}) {
  if (!sponsors?.[placement] || !sponsors.placements.length) return null;
  return (
    <section className="sponsor-credits" aria-label="Published event sponsors">
      <h2>Event sponsors</h2>
      <div className="sponsor-cards">
        {sponsors.placements.map((item) => (
          <article key={item.id}>
            <span className="sponsor-label">Sponsor</span>
            <h3>{item.name}</h3>
            {item.caption && <p>{item.caption}</p>}
            {item.website && (
              <a
                href={item.website}
                target="_blank"
                rel="noopener noreferrer sponsored"
              >
                Visit {item.name}
              </a>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

export function EventSponsors({ eventId }: { eventId: string }) {
  const account = useQuery({
    queryKey: ['session'],
    queryFn: session,
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  if (account.isPending) return <Loading />;
  if (!account.data || account.error)
    return (
      <ErrorNote
        error={account.error ?? new Error('Sign in to manage event sponsors.')}
      />
    );
  return (
    <SponsorEditor
      key={`${account.data.id}:${eventId}`}
      accountId={account.data.id}
      eventId={eventId}
    />
  );
}

function SponsorEditor({
  accountId,
  eventId,
}: {
  accountId: string;
  eventId: string;
}) {
  const cache = useQueryClient(),
    key = ['event-sponsors', accountId, eventId];
  const endpoint = `/events/${eventId}/sponsors`;
  function checked(value: unknown) {
    const result = sponsorState.parse(value);
    if (result.accountId !== accountId || result.eventId !== eventId)
      throw new Error(
        'These sponsor settings belong to another account or event.',
      );
    return result;
  }
  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => checked(await api(endpoint, { signal })),
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  const [baseline, setBaseline] = useState<SponsorState | null>(null);
  const [draft, setDraft] = useState<SponsorFields | null>(null);
  const [permission, setPermission] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  const [conflict, setConflict] = useState(false);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (!baseline && query.data) {
      setBaseline(query.data);
      setDraft(query.data.draft);
    }
  }, [baseline, query.data]);
  const denied =
    (query.error instanceof HttpError &&
      [401, 403, 404].includes(query.error.status)) ||
    (error instanceof HttpError && [401, 403, 404].includes(error.status));
  const stale =
    conflict ||
    Boolean(query.error) ||
    Boolean(
      baseline &&
      query.data &&
      JSON.stringify(baseline) !== JSON.stringify(query.data),
    );
  function adopt(state: SponsorState) {
    setBaseline(state);
    setDraft(state.draft);
    setPermission(false);
    setConflict(false);
    setError(null);
    cache.setQueryData(key, state);
  }
  function change(next: SponsorFields) {
    setDraft(next);
    setPermission(false);
    setMessage('');
  }
  async function refresh() {
    if (busy) return;
    if (
      draft &&
      baseline &&
      JSON.stringify(draft) !== JSON.stringify(baseline.draft) &&
      !window.confirm(
        'Discard the unsaved sponsor draft and load the latest version?',
      )
    )
      return;
    setMessage('');
    setError(null);
    const result = await query.refetch();
    if (result.data && !result.error) adopt(result.data);
  }
  async function save(action: 'save' | 'publish' | 'withdraw') {
    if (!baseline || !draft || busy || stale || pending.current) return;
    if (
      action === 'withdraw' &&
      !window.confirm(
        'Withdraw the published sponsor credits? The private draft will be kept.',
      )
    )
      return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      const command = sponsorCommand.parse(
        action === 'withdraw'
          ? { action, version: baseline.version }
          : action === 'publish'
            ? {
                action,
                version: baseline.version,
                fields: draft,
                permission: permission ? SPONSOR_PERMISSION : null,
              }
            : { action, version: baseline.version, fields: draft },
      );
      const result = checked(
        await api(endpoint, {
          method: 'PUT',
          signal: controller.signal,
          headers: { [SPONSOR_ACTOR]: accountId },
          body: JSON.stringify(command),
        }),
      );
      controller.signal.throwIfAborted();
      adopt(result);
      setMessage(
        action === 'save'
          ? 'Private sponsor draft saved. Published credits are unchanged.'
          : action === 'publish'
            ? 'Sponsor credits published for the selected highlight displays.'
            : 'Sponsor credits withdrawn. Copies already saved by viewers cannot be revoked.',
      );
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure);
        if (failure instanceof HttpError && failure.status === 409)
          setConflict(true);
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (pending.current === controller) pending.current = null;
    }
  }
  if (denied) return <ErrorNote error={query.error ?? error} />;
  if (!draft || !baseline)
    return query.error ? (
      <div>
        <ErrorNote error={query.error} />
        <button type="button" onClick={() => void refresh()}>
          Retry sponsor settings
        </button>
      </div>
    ) : (
      <Loading />
    );
  const blocked = busy || stale || query.isFetching;
  function move(index: number, offset: number) {
    if (!draft) return;
    const placements = [...draft.placements];
    [placements[index], placements[index + offset]] = [
      placements[index + offset]!,
      placements[index]!,
    ];
    change({ ...draft, placements });
  }
  return (
    <section
      className="sponsor-editor stack"
      aria-label="Event sponsor settings"
    >
      <h2>Event sponsor credits</h2>
      <p>
        Prepare private credits, then publish the reviewed version. Credits
        appear only while the event and its published highlights are available
        to signed-in viewers with the link.
      </p>
      <p>
        Publication:{' '}
        {baseline.published ? 'Published snapshot saved' : 'Not published'}.
      </p>
      {!baseline.eventOpen && (
        <p>
          This event is closed. You can edit the private draft or withdraw
          credits. Restore or extend the event before publishing.
        </p>
      )}
      {stale && (
        <p role="alert">
          Sponsor settings changed or could not be refreshed. Load the latest
          version before saving.
        </p>
      )}
      <div className="toolbar">
        <button
          type="button"
          className="button secondary"
          disabled={busy || query.isFetching}
          onClick={() => void refresh()}
        >
          Load latest sponsor settings
        </button>
      </div>
      <fieldset disabled={blocked}>
        <legend>Display the published credits on</legend>
        <label>
          <input
            type="checkbox"
            checked={draft.gallery}
            onChange={(event) =>
              change({ ...draft, gallery: event.target.checked })
            }
          />
          Highlights gallery
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.wall}
            onChange={(event) =>
              change({ ...draft, wall: event.target.checked })
            }
          />
          Live photo wall
        </label>
      </fieldset>
      <div className="sponsor-draft-list">
        {draft.placements.map((item, index) => (
          <fieldset key={item.id} disabled={blocked}>
            <legend>Sponsor {index + 1}</legend>
            {(['name', 'caption', 'website'] as const).map((field) => (
              <label key={field}>
                {field === 'name'
                  ? 'Sponsor name'
                  : field === 'caption'
                    ? 'Sponsor caption'
                    : 'Sponsor website'}
                <input
                  value={item[field]}
                  maxLength={
                    field === 'name' ? 80 : field === 'caption' ? 120 : 300
                  }
                  onChange={(event) =>
                    change({
                      ...draft,
                      placements: draft.placements.map((row) =>
                        row.id === item.id
                          ? { ...row, [field]: event.target.value }
                          : row,
                      ),
                    })
                  }
                />
              </label>
            ))}
            <p>
              Website is optional and must use HTTPS. Every published card is
              labeled Sponsor.
            </p>
            <div className="toolbar">
              <button
                type="button"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                Move sponsor {index + 1} up
              </button>
              <button
                type="button"
                disabled={index === draft.placements.length - 1}
                onClick={() => move(index, 1)}
              >
                Move sponsor {index + 1} down
              </button>
              <button
                type="button"
                onClick={() =>
                  change({
                    ...draft,
                    placements: draft.placements.filter(
                      (row) => row.id !== item.id,
                    ),
                  })
                }
              >
                Remove sponsor {index + 1}
              </button>
            </div>
          </fieldset>
        ))}
      </div>
      <button
        type="button"
        className="button secondary"
        disabled={blocked || draft.placements.length >= SPONSOR_LIMIT}
        onClick={() =>
          change({
            ...draft,
            placements: [
              ...draft.placements,
              { id: crypto.randomUUID(), name: '', caption: '', website: '' },
            ],
          })
        }
      >
        Add sponsor
      </button>
      <label className="sponsor-permission">
        <input
          type="checkbox"
          checked={permission}
          disabled={blocked}
          onChange={(event) => setPermission(event.target.checked)}
        />
        I have permission to publish these sponsor details on the selected event
        displays.
      </label>
      <div className="toolbar">
        <button
          type="button"
          className="button secondary"
          disabled={blocked}
          onClick={() => void save('save')}
        >
          Save private sponsor draft
        </button>
        <button
          type="button"
          className="button"
          disabled={
            blocked ||
            !permission ||
            !baseline.eventOpen ||
            !draft.placements.length ||
            !(draft.gallery || draft.wall)
          }
          onClick={() => void save('publish')}
        >
          Publish sponsor credits
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={blocked || !baseline.published}
          onClick={() => void save('withdraw')}
        >
          Withdraw sponsor credits
        </button>
      </div>
      <ErrorNote error={error ?? query.error} />
      <p role="status">{busy ? 'Saving sponsor settings...' : message}</p>
      {baseline.published && (
        <section aria-label="Current published sponsor snapshot">
          <h3>Current published version</h3>
          <p>
            Saved {new Date(baseline.published.publishedAt).toLocaleString()}.
            Draft changes remain private until you publish again.
          </p>
          <ol>
            {baseline.published.fields.placements.map((item) => (
              <li key={item.id}>
                <strong>{item.name}</strong>
                {item.caption && `: ${item.caption}`}
              </li>
            ))}
          </ol>
        </section>
      )}
    </section>
  );
}
