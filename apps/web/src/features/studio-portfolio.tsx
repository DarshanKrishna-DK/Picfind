import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, fileUrl, HttpError, session } from '../api';
import { ErrorNote, Loading, PageTitle } from '../components/ui';
import {
  PORTFOLIO_ACTOR,
  PORTFOLIO_CONSENT,
  PORTFOLIO_PAGE_SIZE,
  PORTFOLIO_PHOTO_LIMIT,
  portfolioChoices,
  portfolioCommand,
  portfolioSnapshot,
  publicPortfolio,
  type PortfolioFields,
  type PortfolioSnapshot,
  type PublicPortfolio,
} from '../../../../packages/shared/src/studio-portfolio';
import './studio-portfolio.css';

const denied = (failure: unknown) =>
  failure instanceof HttpError && [401, 403].includes(failure.status);
export function StudioPortfolio() {
  const account = useQuery({
    queryKey: ['session'],
    queryFn: session,
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  if (account.isPending) return <Loading />;
  if (account.error || !account.data)
    return (
      <ErrorNote
        error={account.error ?? new Error('Sign in to edit your portfolio.')}
      />
    );
  return <PortfolioEditor key={account.data.id} accountId={account.data.id} />;
}
function PortfolioEditor({ accountId }: { accountId: string }) {
  const cache = useQueryClient(),
    key = ['studio-portfolio', accountId];
  const [baseline, setBaseline] = useState<PortfolioSnapshot | null>(null);
  const [draft, setDraft] = useState<PortfolioFields | null>(null);
  const [search, setSearch] = useState(''),
    [offset, setOffset] = useState(0);
  const [permission, setPermission] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null),
    [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const headers = { [PORTFOLIO_ACTOR]: accountId };
  async function read(signal: AbortSignal) {
    const value = portfolioSnapshot.parse(
      await api('/studio/portfolio', { signal, headers }),
    );
    if (value.accountId !== accountId)
      throw new HttpError(403, 'Your signed-in account changed.');
    return value;
  }
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => read(signal),
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  const choices = useQuery({
    queryKey: [...key, 'photos', search, offset],
    retry: false,
    refetchOnWindowFocus: 'always',
    queryFn: async ({ signal }) => {
      const value = portfolioChoices.parse(
        await api(
          `/studio/portfolio/photos?${new URLSearchParams({ search, offset: String(offset) })}`,
          { signal, headers },
        ),
      );
      if (value.accountId !== accountId)
        throw new HttpError(403, 'Your signed-in account changed.');
      return value;
    },
  });
  useEffect(() => {
    if (!baseline && query.data && !query.error) {
      setBaseline(query.data);
      setDraft(query.data.portfolio.draft);
    }
  }, [baseline, query.data, query.error]);
  function adopt(value: PortfolioSnapshot) {
    cache.setQueryData(key, value);
    setBaseline(value);
    setDraft(value.portfolio.draft);
    setPermission(false);
    setConflict(false);
  }
  const dirty =
    !!draft &&
    JSON.stringify(draft) !== JSON.stringify(baseline?.portfolio.draft);
  const stale =
    conflict ||
    !!query.error ||
    !!(
      baseline &&
      query.data &&
      baseline.portfolio.version !== query.data.portfolio.version
    );
  async function run(
    work: (signal: AbortSignal) => Promise<PortfolioSnapshot>,
    success: string,
    failedRead = false,
  ) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      const value = await work(controller.signal);
      if (!controller.signal.aborted) {
        adopt(value);
        setMessage(success);
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure);
        if (
          failedRead ||
          (failure instanceof HttpError && failure.status === 409)
        )
          setConflict(true);
      }
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  function reload() {
    if (
      dirty &&
      !window.confirm(
        'Discard your unsaved portfolio draft and load the latest saved version?',
      )
    )
      return;
    void run(read, 'Latest saved portfolio loaded.', true);
  }
  function save(action: 'save' | 'publish' | 'withdraw') {
    if (!baseline || !draft || stale || query.isFetching || busy) return;
    const input = portfolioCommand.safeParse({
      action,
      fields: action === 'withdraw' ? baseline.portfolio.draft : draft,
      version: baseline.portfolio.version,
      permission: action === 'publish' && permission ? PORTFOLIO_CONSENT : null,
    });
    if (!input.success) {
      setError(
        new Error(
          'Check the fields, photo selection and publication permission. Shorten long details if necessary.',
        ),
      );
      return;
    }
    if (
      action === 'publish' &&
      !window.confirm(
        'Publish this profile and every selected photograph for anyone with the link to view and save?',
      )
    )
      return;
    if (
      action === 'withdraw' &&
      !window.confirm(
        'Withdraw the public page? Copies already downloaded by visitors cannot be revoked. Unsaved changes will be discarded.',
      )
    )
      return;
    void run(
      async (signal) => {
        const value = portfolioSnapshot.parse(
          await api('/studio/portfolio', {
            method: 'PUT',
            signal,
            headers,
            body: JSON.stringify(input.data),
          }),
        );
        if (value.accountId !== accountId || value.id !== baseline.id)
          throw new HttpError(
            403,
            'This portfolio belongs to another account.',
          );
        return value;
      },
      action === 'publish'
        ? 'Portfolio published.'
        : action === 'withdraw'
          ? 'Portfolio withdrawn. Your saved draft is retained.'
          : 'Private draft saved. The published page is unchanged.',
    );
  }
  const unavailable = new Set(query.data?.unavailableIds ?? []);
  function update(value: PortfolioFields) {
    setDraft(value);
    setPermission(false);
  }
  function move(index: number, delta: number) {
    if (!draft) return;
    const photos = [...draft.photos],
      target = index + delta;
    if (target < 0 || target >= photos.length) return;
    [photos[index], photos[target]] = [photos[target]!, photos[index]!];
    update({ ...draft, photos });
  }
  if (denied(query.error) || denied(choices.error) || denied(error))
    return (
      <section>
        <h1>Portfolio unavailable</h1>
        <ErrorNote error={error || query.error || choices.error} />
      </section>
    );
  return (
    <section className="portfolio-editor">
      <PageTitle title="Portfolio" eyebrow="Your photography, your selection" />
      <p>
        Prepare a private draft, then publish only the profile and photographs
        you select. Publishing does not change access to your source galleries.
      </p>
      <ErrorNote error={error || query.error} />
      <p role="status">{message}</p>
      <button
        className="button secondary"
        disabled={busy || query.isFetching}
        onClick={reload}
      >
        Load latest portfolio
      </button>
      {query.isPending && <Loading />}
      {baseline && draft && (
        <>
          <div className="glass-panel portfolio-publication">
            <strong>
              {baseline.portfolio.published
                ? 'Public page is live'
                : 'Portfolio is private'}
            </strong>
            {baseline.portfolio.published && (
              <Link
                to={`/portfolio/${baseline.id}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                View published portfolio
              </Link>
            )}
            <p>
              Saving changes does not update the public page. Publish again to
              replace its selection.
            </p>
          </div>
          {stale && (
            <p role="alert">
              The saved portfolio changed or could not be refreshed. Your draft
              is preserved. Load the latest version before saving.
            </p>
          )}
          <fieldset className="glass-panel portfolio-fields" disabled={busy}>
            <legend>Profile details</legend>
            {(
              [
                ['name', 'Display name', 100],
                ['tagline', 'Tagline', 160],
                ['location', 'Location', 120],
                ['website', 'Website (HTTPS)', 300],
              ] as const
            ).map(([field, title, max]) => (
              <label key={field}>
                {title}
                <input
                  value={draft[field]}
                  maxLength={max}
                  onChange={(event) =>
                    update({ ...draft, [field]: event.target.value })
                  }
                />
              </label>
            ))}
            <label>
              Biography
              <textarea
                value={draft.biography}
                maxLength={1000}
                rows={4}
                onChange={(event) =>
                  update({ ...draft, biography: event.target.value })
                }
              />
            </label>
            <label>
              Page theme
              <select
                value={draft.theme}
                onChange={(event) =>
                  update({
                    ...draft,
                    theme: event.target.value as PortfolioFields['theme'],
                  })
                }
              >
                <option value="linen">Linen</option>
                <option value="forest">Forest</option>
                <option value="midnight">Midnight</option>
              </select>
            </label>
          </fieldset>
          <section aria-label="Selected portfolio photographs">
            <h2>
              Selected photographs ({draft.photos.length}/
              {PORTFOLIO_PHOTO_LIMIT})
            </h2>
            <p>
              Order determines the public gallery. The first available image
              leads the page.
            </p>
            {!draft.photos.length && (
              <p>Select photographs from your event library below.</p>
            )}
            <div className="portfolio-selection">
              {draft.photos.map((photo, index) => (
                <article className="glass-panel" key={photo.id}>
                  {unavailable.has(photo.id) ? (
                    <p>Unavailable photograph. Remove it before publishing.</p>
                  ) : (
                    <img
                      src={fileUrl(photo.id)}
                      alt={`Selected photograph ${index + 1}`}
                      loading="lazy"
                    />
                  )}
                  <label>
                    Caption {index + 1}
                    <input
                      value={photo.caption}
                      maxLength={200}
                      disabled={busy}
                      onChange={(event) =>
                        update({
                          ...draft,
                          photos: draft.photos.map((row) =>
                            row.id === photo.id
                              ? { ...row, caption: event.target.value }
                              : row,
                          ),
                        })
                      }
                    />
                  </label>
                  <div className="portfolio-actions">
                    <button
                      className="button secondary"
                      disabled={busy || index === 0}
                      aria-label={`Move photograph ${index + 1} earlier`}
                      onClick={() => move(index, -1)}
                    >
                      Earlier
                    </button>
                    <button
                      className="button secondary"
                      disabled={busy || index === draft.photos.length - 1}
                      aria-label={`Move photograph ${index + 1} later`}
                      onClick={() => move(index, 1)}
                    >
                      Later
                    </button>
                    <button
                      className="button secondary"
                      disabled={busy}
                      aria-label={`Remove photograph ${index + 1}`}
                      onClick={() =>
                        update({
                          ...draft,
                          photos: draft.photos.filter(
                            (row) => row.id !== photo.id,
                          ),
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
          <section className="glass-panel portfolio-library">
            <h2>Add from your event library</h2>
            <label>
              Search available photographs
              <input
                type="search"
                value={search}
                maxLength={200}
                disabled={busy}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setOffset(0);
                }}
              />
            </label>
            <ErrorNote error={choices.error} />
            {choices.isPending && <Loading />}
            {choices.data && !choices.error && (
              <>
                <p>
                  {choices.data.total} available photographs match this search.
                </p>
                <div className="portfolio-choices">
                  {choices.data.photos.map((photo) => {
                    const selected = draft.photos.some(
                      (row) => row.id === photo.id,
                    );
                    return (
                      <button
                        className="glass-panel"
                        key={photo.id}
                        disabled={
                          busy ||
                          selected ||
                          draft.photos.length >= PORTFOLIO_PHOTO_LIMIT
                        }
                        aria-label={`Add photograph: ${photo.filename}`}
                        onClick={() =>
                          update({
                            ...draft,
                            photos: [
                              ...draft.photos,
                              { id: photo.id, caption: '' },
                            ],
                          })
                        }
                      >
                        <img src={fileUrl(photo.id)} alt="" loading="lazy" />
                        <strong>{photo.filename}</strong>
                        <span>{photo.eventTitle}</span>
                        <span>{selected ? 'Selected' : 'Add to draft'}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="portfolio-actions">
                  <button
                    className="button secondary"
                    disabled={busy || offset === 0}
                    onClick={() =>
                      setOffset(Math.max(0, offset - PORTFOLIO_PAGE_SIZE))
                    }
                  >
                    Previous photographs
                  </button>
                  <button
                    className="button secondary"
                    disabled={
                      busy || offset + PORTFOLIO_PAGE_SIZE >= choices.data.total
                    }
                    onClick={() => setOffset(offset + PORTFOLIO_PAGE_SIZE)}
                  >
                    Next photographs
                  </button>
                </div>
              </>
            )}
          </section>
          <div className="glass-panel portfolio-publish">
            <label>
              <input
                type="checkbox"
                checked={permission}
                disabled={busy}
                onChange={(event) => setPermission(event.target.checked)}
              />
              I have permission to publish these photographs and profile details
              for anyone to view and save.
            </label>
            <p>
              Visitors can keep downloaded copies. Withdrawing the page prevents
              future access through this link but cannot revoke those copies.
            </p>
            <div className="portfolio-actions">
              <button
                className="button secondary"
                disabled={busy || stale || query.isFetching}
                onClick={() => save('save')}
              >
                Save private draft
              </button>
              <button
                className="button"
                disabled={
                  busy ||
                  stale ||
                  query.isFetching ||
                  !permission ||
                  !draft.photos.length ||
                  draft.photos.some((photo) => unavailable.has(photo.id))
                }
                onClick={() => save('publish')}
              >
                Publish portfolio
              </button>
              {baseline.portfolio.published && (
                <button
                  className="button secondary"
                  disabled={busy || stale || query.isFetching}
                  onClick={() => save('withdraw')}
                >
                  Withdraw portfolio
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
export function PublicPhotographerPortfolio() {
  const { id } = useParams();
  const query = useQuery({
    queryKey: ['public-portfolio', id],
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: 'always',
    queryFn: async ({ signal }) => {
      const value = publicPortfolio.parse(
        await api(`/public/portfolios/${id}`, { signal }),
      );
      if (value.id !== id) throw new Error('This portfolio is unavailable.');
      return value;
    },
  });
  if (query.isPending) return <Loading />;
  if (query.error || !query.data)
    return (
      <section className="wrap standalone">
        <h1>Portfolio unavailable</h1>
        <p>The photographer may have withdrawn this page.</p>
        <ErrorNote error={query.error} />
      </section>
    );
  return <PortfolioPresentation value={query.data} />;
}
function PortfolioPresentation({ value }: { value: PublicPortfolio }) {
  return (
    <section
      className={`photographer-portfolio portfolio-theme-${value.theme}`}
    >
      <header>
        <span className="eyebrow">Photography portfolio</span>
        <h1>{value.name}</h1>
        {value.tagline && <p className="portfolio-tagline">{value.tagline}</p>}
        {value.location && <p>{value.location}</p>}
        {value.biography && (
          <p className="portfolio-biography">{value.biography}</p>
        )}
        {value.website && (
          <a
            className="button secondary"
            href={value.website}
            target="_blank"
            rel="noopener noreferrer"
          >
            Visit photographer website
          </a>
        )}
      </header>
      {!value.photos.length && (
        <p>No photographs are currently available in this portfolio.</p>
      )}
      <div className="portfolio-public-gallery">
        {value.photos.map((photo, index) => (
          <figure key={photo.id}>
            <img
              src={`/api/public/portfolios/${value.id}/photos/${photo.id}`}
              alt={photo.caption || `Portfolio photograph ${index + 1}`}
              width={photo.width ?? undefined}
              height={photo.height ?? undefined}
              loading={index === 0 ? 'eager' : 'lazy'}
            />
            {photo.caption && <figcaption>{photo.caption}</figcaption>}
          </figure>
        ))}
      </div>
      <footer>Shared by the photographer with PicFind.</footer>
    </section>
  );
}
