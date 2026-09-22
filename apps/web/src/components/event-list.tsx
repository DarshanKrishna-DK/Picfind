import { Link, useSearchParams } from 'react-router';
import { ArrowUpRight, CalendarDays, Plus, Search } from 'lucide-react';
import { fileUrl, type GalleryEvent } from '../api';
import { useLibrary } from '../hooks';
import { Empty, ErrorNote, Loading, PageTitle } from './ui';
import { MenuSelect } from './menu-select';
import '../features/organizer.css';

export function eventStatus(event: GalleryEvent, now = Date.now()) {
  if (event.archived) return 'Archived';
  if (event.expiresAt && Date.parse(event.expiresAt) <= now) return 'Expired';
  return event.visibility === 'link' ? 'Shared' : 'Private';
}

export function EventList() {
  const query = useLibrary();
  const [params, setParams] = useSearchParams();
  const search = params.get('q') ?? '';
  const status = params.get('status') ?? 'All events';
  const sort = params.get('sort') ?? 'newest';
  const folder = params.get('folder') ?? '';
  function filter(name: string, value: string) {
    // Router search-param callbacks are render snapshots, not queued state
    // updaters. Read the committed URL so a fast reset + sort cannot restore
    // filters from a previous render while navigation is still transitioning.
    const next = new URLSearchParams(window.location.search);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next, { replace: true });
  }
  const events = query.data?.events ?? [];
  const folders = [
    ...new Set(events.flatMap((event) => (event.folder ? [event.folder] : []))),
  ].sort((a, b) => a.localeCompare(b));
  const filtered = events
    .filter(
      (event) =>
        `${event.title} ${event.description} ${event.folder ?? ''}`
          .toLocaleLowerCase()
          .includes(search.trim().toLocaleLowerCase()) &&
        (!folder ||
          (folder === 'unfiled'
            ? !event.folder
            : `folder:${event.folder}` === folder)) &&
        (status === 'All events' || eventStatus(event) === status),
    )
    .sort((a, b) => {
      if (sort === 'name')
        return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
      if (sort === 'date') {
        if (!a.date || !b.date)
          return a.date ? -1 : b.date ? 1 : a.id.localeCompare(b.id);
        return b.date.localeCompare(a.date) || a.id.localeCompare(b.id);
      }
      return b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
    });
  return (
    <>
      <PageTitle eyebrow="EVENT GALLERIES" title="Your events.">
        <Link className="button" to="/app/events/new">
          <Plus size={18} />
          Create event
        </Link>
      </PageTitle>
      <p className="page-description">
        Keep track of what is private, shared, or ready to close. Each event has
        its own gallery and sharing settings.
      </p>
      <div className="event-summary" aria-label="Event overview">
        {['Private', 'Shared', 'Expired', 'Archived'].map((value) => (
          <button
            key={value}
            aria-pressed={status === value}
            onClick={() => filter('status', status === value ? '' : value)}
          >
            <strong>
              {events.filter((event) => eventStatus(event) === value).length}
            </strong>
            <span>{value}</span>
          </button>
        ))}
      </div>
      <section
        className="event-filters glass-panel"
        aria-label="Filter event galleries"
      >
        <label>
          <span>
            <Search size={14} /> Search events
          </span>
          <input
            type="search"
            aria-label="Search events"
            placeholder="Event, client or folder"
            maxLength={120}
            value={search}
            onChange={(event) => filter('q', event.target.value)}
          />
        </label>
        <label>
          Event folder
          <MenuSelect
            label="Event folder"
            value={folder}
            onChange={(next) => filter('folder', next)}
            options={[
              { value: '', label: 'All folders' },
              { value: 'unfiled', label: 'Unfiled' },
              ...folders.map((name) => ({
                value: `folder:${name}`,
                label: name,
              })),
            ]}
          />
        </label>
        <label>
          Visibility
          <MenuSelect
            label="Filter events"
            value={status}
            onChange={(next) => filter('status', next)}
            options={['All events', 'Private', 'Shared', 'Expired', 'Archived'].map(
              (value) => ({ value, label: value }),
            )}
          />
        </label>
        <label>
          Sort events
          <MenuSelect
            label="Sort events"
            value={sort}
            onChange={(next) => filter('sort', next)}
            options={[
              { value: 'newest', label: 'Recently created' },
              { value: 'name', label: 'Event name' },
              { value: 'date', label: 'Event date, newest first' },
            ]}
          />
        </label>
        <div className="event-filter-summary">
          <span role="status">
            {filtered.length} of {events.length} events
          </span>
          <button className="text-link" onClick={() => setParams({})}>
            Reset filters
          </button>
        </div>
      </section>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <>
          <ErrorNote error={query.error} />
          <button
            className="button secondary"
            onClick={() => void query.refetch()}
          >
            Try again
          </button>
        </>
      ) : !filtered.length ? (
        <Empty
          title={
            events.length
              ? 'No events match these filters.'
              : 'Give your next event a gallery.'
          }
          text={
            events.length
              ? 'Try a different name or show all events.'
              : 'Add the details, upload your photos, then share when you are ready.'
          }
        >
          {events.length ? (
            <button className="button secondary" onClick={() => setParams({})}>
              Clear filters
            </button>
          ) : (
            <Link className="button secondary" to="/app/events/new">
              Create event
            </Link>
          )}
        </Empty>
      ) : (
        <div className="event-grid">
          {filtered.map((event) => {
            const photos = query.data!.photos.filter(
              (photo) => photo.eventId === event.id,
            );
            return (
              <Link
                to={`/app/events/${event.id}`}
                className="event-card"
                key={event.id}
              >
                <div className="event-cover">
                  {photos[0] ? (
                    <img
                      src={fileUrl(photos[0].id)}
                      loading="lazy"
                      decoding="async"
                      alt=""
                    />
                  ) : (
                    <CalendarDays size={46} strokeWidth={1} />
                  )}
                </div>
                <div className="event-card-body">
                  <span
                    className={`event-state ${eventStatus(event).toLowerCase()}`}
                  >
                    {eventStatus(event)}
                  </span>
                  <h2>{event.title}</h2>
                  {event.folder && (
                    <p className="event-folder-label">{event.folder}</p>
                  )}
                  <p>
                    {event.date || 'Date not set'} / {photos.length} photos
                  </p>
                  {event.expiresAt && (
                    <p className="field-help">
                      {eventStatus(event) === 'Expired'
                        ? 'Expired'
                        : 'Access ends'}{' '}
                      {new Date(event.expiresAt).toLocaleDateString()}
                    </p>
                  )}
                  <span className="text-link">
                    Manage event <ArrowUpRight size={18} />
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
