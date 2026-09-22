import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  ArrowUpRight,
  CalendarDays,
  Check,
  CloudUpload,
  Images,
  ScanFace,
  ShieldCheck,
} from 'lucide-react';
import { api, session, type Capabilities } from '../api';
import { useLibrary } from '../hooks';
import { eventStatus } from '../components/event-list';
import { ErrorNote, Loading, PageTitle } from '../components/ui';
import './dashboard.css';

export function Dashboard() {
  const library = useLibrary();
  const account = useQuery({ queryKey: ['session'], queryFn: session });
  const capabilities = useQuery({
    queryKey: ['capabilities'],
    queryFn: () => api<Capabilities>('/capabilities'),
  });
  const [guide, setGuide] = useState<'find' | 'host' | 'guest'>('find');
  if (library.isPending) return <Loading />;
  if (library.error)
    return (
      <section className="glass-panel">
        <h1>Your studio is taking a moment.</h1>
        <ErrorNote error={library.error} />
        <button className="button" onClick={() => void library.refetch()}>
          Reload studio
        </button>
      </section>
    );
  const { photos, events, scans = [], jobs, photoLimit } = library.data!;
  const live = events.filter((event) => eventStatus(event) === 'Shared');
  const storage = photos.reduce((sum, photo) => sum + photo.bytes, 0);
  const recent = [...events]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 4);
  const guides = {
    find: {
      title: 'Find photos from an album',
      steps: [
        {
          title: 'Bring the album into PicFind',
          text: 'Open Import photos. Upload a folder, or connect Google Drive / Dropbox and copy photos into your personal library.',
          to: '/app/import',
        },
        {
          title: 'Search with your selfie',
          text: 'Open Find my photos, pick the imported album, add a clear selfie, and review likely matches. Download the ones you want.',
          to: '/app/discover/new',
        },
      ],
    },
    host: {
      title: 'Upload media and share with participants',
      steps: [
        {
          title: 'Create the event',
          text: 'Name the occasion and set when the gallery should expire. You get a private link and QR immediately.',
          to: '/app/events/new',
        },
        {
          title: 'Add this event’s photos',
          text: 'Upload from your device or import from a connected cloud account. Everything stays in this event, not your personal library.',
          to: recent[0] ? `/app/events/${recent[0].id}` : '/app/import',
        },
        {
          title: 'Share the QR or link',
          text: 'Guests sign in, open the secret link, then browse, download, or search with a selfie. They do not pay.',
          to: recent[0] ? `/app/events/${recent[0].id}` : '/app/events',
        },
      ],
    },
    guest: {
      title: 'Join an event as a participant',
      steps: [
        {
          title: 'Open the organizer’s QR or link',
          text: 'There is no public event list. Scan the QR or paste the secret link the organizer sent you.',
          to: '/sign-in',
        },
        {
          title: 'Sign in, then browse or search',
          text: 'After sign-in you land on that event gallery. Download photos yourself or upload a selfie to find your matches.',
          to: '/sign-in',
        },
      ],
    },
  } as const;
  const activeGuide = guides[guide];
  const steps = [
    {
      title: 'Create a private event',
      text: 'Give the occasion a name. Nothing is public yet.',
      to: '/app/events/new',
      complete: events.length > 0,
    },
    {
      title: 'Bring in your photographs',
      text: 'Upload from your device or connect a read-only source.',
      to: recent[0] ? `/app/events/${recent[0].id}` : '/app/import',
      complete: photos.some((photo) => photo.eventId),
    },
    {
      title: 'Share on your terms',
      text: 'Review access, then share a gallery link or QR code.',
      to: recent[0] ? `/app/events/${recent[0].id}` : '/app/events/new',
      complete: live.length > 0,
    },
  ];
  return (
    <>
      <PageTitle
        eyebrow="YOUR PICFIND STUDIO"
        title={`Welcome${account.data?.name ? `, ${account.data.name.split(' ')[0]}` : ' back'}.`}
      >
        <Link className="button secondary" to="/app/events/new">
          Create event <ArrowUpRight size={18} />
        </Link>
      </PageTitle>
      <p className="page-description">
        Find your own photographs or manage an event for your guests. Each has
        its own collection and allowance.
      </p>
      <section className="dashboard-paths" aria-label="Start or continue">
        <article className="dashboard-path glass-panel">
          <ScanFace size={26} aria-hidden="true" />
          <div>
            <h2>Find your photos</h2>
            <p>
              Connect a folder or upload photos, then search with your selfie.
              Personal packs never pay for an event.
            </p>
          </div>
          <Link className="button" to="/app/discover/new">
            Find my photos <ArrowUpRight size={17} />
          </Link>
        </article>
        <article className="dashboard-path glass-panel">
          <CalendarDays size={26} aria-hidden="true" />
          <div>
            <h2>Manage your events</h2>
            <p>
              Add event photos, share a private link or QR, and let signed-in
              guests browse and find their moments. Guests do not pay.
            </p>
          </div>
          <Link className="button secondary" to="/app/events">
            Open events <ArrowUpRight size={17} />
          </Link>
        </article>
      </section>
      <section className="studio-metrics" aria-label="Your library at a glance">
        {[
          {
            label: 'Library photos',
            value: photos.length,
            note:
              library.data!.capacityMode === 'metered'
                ? 'Storage and processing follow your allowance'
                : `${photoLimit} photo preview capacity`,
            icon: Images,
          },
          {
            label: 'Active shared events',
            value: live.length,
            note: `${events.length} events in your studio`,
            icon: CalendarDays,
          },
          {
            label: 'Saved discoveries',
            value: scans.length,
            note: 'Search sessions, not individual people',
            icon: ScanFace,
          },
          {
            label: 'Optimized storage',
            value: `${(storage / 1024 / 1024).toFixed(1)} MB`,
            note: 'Keep original camera files separately',
            icon: CloudUpload,
          },
        ].map(({ label, value, note, icon: Icon }) => (
          <article className="glass-panel metric-card" key={label}>
            <Icon size={21} />
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{note}</small>
          </article>
        ))}
      </section>
      <details className="dashboard-guide glass-panel">
        <summary>
          Gallery setup guide{' '}
          <span>
            {steps.filter((step) => step.complete).length} of 3 steps complete
          </span>
        </summary>
        <div className="studio-onboarding">
          <div>
            <p className="eyebrow">FROM FIRST PHOTO TO FIRST GUEST</p>
            <h2>Your next gallery, in three steps.</h2>
            <p>
              Pick up where you left off. You control when a private event
              becomes a shared gallery.
            </p>
          </div>
          <ol>
            {steps.map((step, index) => (
              <li key={step.title}>
                <span
                  className={
                    step.complete ? 'step-number complete' : 'step-number'
                  }
                >
                  {step.complete ? (
                    <Check size={17} aria-label="Completed" />
                  ) : (
                    `0${index + 1}`
                  )}
                </span>
                <div>
                  <Link to={step.to}>
                    {step.title}
                    <ArrowUpRight size={15} />
                  </Link>
                  <p>{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </details>
      <details className="dashboard-guide glass-panel">
        <summary>User guide</summary>
        <div className="user-guide">
          <div className="user-guide-tabs" role="tablist" aria-label="Use cases">
            {(
              [
                ['find', 'Find photos from an album'],
                ['host', 'Share an event gallery'],
                ['guest', 'Join as a participant'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={guide === id}
                onClick={() => setGuide(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="studio-onboarding" role="tabpanel">
            <div>
              <p className="eyebrow">HOW THIS WORKS</p>
              <h2>{activeGuide.title}</h2>
            </div>
            <ol>
              {activeGuide.steps.map((step, index) => (
                <li key={step.title}>
                  <span className="step-number">0{index + 1}</span>
                  <div>
                    <Link to={step.to}>
                      {step.title}
                      <ArrowUpRight size={15} />
                    </Link>
                    <p>{step.text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </details>
      <section className="studio-columns">
        <div className="glass-panel studio-recent">
          <div className="section-heading">
            <h2>Recent occasions</h2>
            <Link className="text-link" to="/app/events">
              All events <ArrowUpRight size={16} />
            </Link>
          </div>
          {recent.length ? (
            recent.map((event) => (
              <Link
                className="recent-event"
                key={event.id}
                to={`/app/events/${event.id}`}
              >
                <CalendarDays size={22} />
                <span>
                  <strong>{event.title}</strong>
                  <small>
                    {event.date || 'Date not set'} /{' '}
                    {
                      photos.filter((photo) => photo.eventId === event.id)
                        .length
                    }{' '}
                    photos
                  </small>
                </span>
                <span
                  className={`event-state ${eventStatus(event).toLowerCase()}`}
                >
                  {eventStatus(event)}
                </span>
              </Link>
            ))
          ) : (
            <div className="studio-empty">
              <CalendarDays size={34} strokeWidth={1.2} />
              <h3>Your story starts here.</h3>
              <p>Start private, add your photos, then invite your guests.</p>
              <Link className="text-link" to="/app/events/new">
                Create your first event <ArrowUpRight size={16} />
              </Link>
            </div>
          )}
        </div>
        <div className="glass-panel studio-readiness">
          <ShieldCheck size={26} />
          <h2>Service status</h2>
          <ul>
            <li>
              Library storage{' '}
              <strong>
                {capabilities.isPending
                  ? 'Checking'
                  : capabilities.error
                    ? 'Unknown'
                    : capabilities.data?.storage
                      ? 'Configured'
                      : 'Not configured'}
              </strong>
            </li>
            <li>
              Face search{' '}
              <strong>
                {capabilities.isPending
                  ? 'Checking'
                  : capabilities.error
                    ? 'Unknown'
                    : capabilities.data?.faceMatching
                      ? 'Available'
                      : 'Currently off'}
              </strong>
            </li>
            <li>
              Source access <strong>Read-only</strong>
            </li>
          </ul>
          <p>
            Indexing requires your consent. Opening this studio never starts
            paid photo processing.
          </p>
          <ErrorNote error={capabilities.error} />
          {capabilities.error && (
            <button
              className="text-link"
              onClick={() => void capabilities.refetch()}
            >
              Check again
            </button>
          )}
        </div>
      </section>
      {jobs.some((job) => job.errors.length > 0) && (
        <section className="glass-panel studio-attention">
          <h2>An import needs a look.</h2>
          <p>
            {jobs.filter((job) => job.errors.length > 0).length} import jobs
            reported errors. Review the import history before retrying.
          </p>
          <Link className="text-link" to="/app/import">
            Review imports <ArrowUpRight size={16} />
          </Link>
        </section>
      )}
    </>
  );
}
