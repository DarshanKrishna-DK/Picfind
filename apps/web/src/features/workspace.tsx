import { useEffect, useRef, useState } from 'react';
import {
  Link,
  NavLink,
  Navigate,
  useLocation,
  useNavigate,
} from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpRight,
  CalendarDays,
  ChevronRight,
  CloudUpload,
  CreditCard,
  Images,
  CopyCheck,
  LayoutDashboard,
  LogOut,
  Menu,
  ScanFace,
  Settings,
  X,
  Users,
  BriefcaseBusiness,
} from 'lucide-react';
import { api, session, HttpError } from '../api';
import { useLibrary } from '../hooks';
import { ErrorNote, Loading, Brand } from '../components/ui';
import { RouteContent } from '../components/route-content';
import {
  billingUsage,
  type BillingUsageSummary,
} from '../../../../packages/shared/src/billing-view';

const destinations = [
  { to: '/app', title: 'Overview', icon: LayoutDashboard },
  { to: '/app/library', title: 'Photo library', icon: Images },
  { to: '/app/events', title: 'Events', icon: CalendarDays },
  { to: '/app/event-deadlines', title: 'Event deadlines', icon: CalendarDays },
  { to: '/app/clients', title: 'Clients', icon: Users },
  { to: '/app/enquiries', title: 'Enquiries', icon: Users },
  { to: '/app/services', title: 'Services', icon: BriefcaseBusiness },
  { to: '/app/expenses', title: 'Expenses', icon: CreditCard },
  { to: '/app/portfolio', title: 'Portfolio', icon: Images },
  { to: '/app/credits', title: 'Photo credits', icon: Users },
  { to: '/app/projects', title: 'Projects', icon: BriefcaseBusiness },
  { to: '/app/work', title: 'Work queue', icon: CalendarDays },
  { to: '/app/schedule', title: 'Schedule', icon: CalendarDays },
  { to: '/app/import', title: 'Import photos', icon: CloudUpload },
  { to: '/app/duplicates', title: 'Duplicate review', icon: CopyCheck },
  { to: '/app/discover/new', title: 'Find my photos', icon: ScanFace },
  { to: '/app/settings', title: 'Settings', icon: Settings },
  { to: '/app/billing', title: 'Billing & usage', icon: CreditCard },
];
export function Workspace() {
  const query = useQuery({ queryKey: ['session'], queryFn: session });
  const library = useLibrary(Boolean(query.data));
  const usage = useQuery({
    queryKey: ['billing'],
    queryFn: () => api<BillingUsageSummary>('/billing'),
    enabled: Boolean(query.data),
    retry: false,
  });
  const location = useLocation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [menu, setMenu] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setMenu(false);
  }, [location.pathname]);
  useEffect(() => {
    if (!menu) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenu(false);
        toggle.current?.focus();
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [menu]);
  if (query.isPending)
    return (
      <div className="wrap standalone">
        <Loading />
      </div>
    );
  if (query.error)
    return (
      <main className="wrap standalone recovery-card">
        <Brand />
        <h1>Your studio is taking a moment.</h1>
        <ErrorNote error={query.error} />
        <p>We could not check your session. Your library remains private.</p>
        <button className="button" onClick={() => void query.refetch()}>
          Try again
        </button>{' '}
        <Link className="text-link" to="/sign-in">
          Go to sign in
        </Link>
      </main>
    );
  if (!query.data)
    return (
      <Navigate
        to="/sign-in"
        state={{ returnTo: location.pathname + location.search }}
        replace
      />
    );
  async function logout() {
    setLoggingOut(true);
    try {
      await api('/auth/session', { method: 'DELETE' });
      client.clear();
      navigate('/sign-in', { replace: true });
    } catch (failure) {
      setError(failure);
    } finally {
      setLoggingOut(false);
    }
  }
  const current =
    location.pathname === '/app/enquiry-report'
      ? 'Enquiry report'
      : ([...destinations]
          .reverse()
          .find(
            (item) =>
              location.pathname === item.to ||
              location.pathname.startsWith(`${item.to}/`),
          )?.title ?? 'Overview');
  const eventId = location.pathname.startsWith('/app/events/')
    ? location.pathname.split('/')[3]
    : new URLSearchParams(location.search).get('eventId');
  const moderator =
    library.data?.events.some(
      (event) => event.id === eventId && event.accessRole === 'moderator',
    ) === true;
  const organizerContext =
    location.pathname.startsWith('/app/events') ||
    Boolean(eventId) ||
    new URLSearchParams(location.search).get('context') === 'organizer';
  const organizerUsage = billingUsage(usage.data, 'organizer');
  const allowance =
    organizerContext && organizerUsage.hasPlan
      ? organizerUsage
      : billingUsage(usage.data, 'personal');
  const processed = allowance.processed;
  const remainingPhotos = allowance.photosRemaining;
  const billingDisabled =
    usage.error instanceof HttpError && usage.error.code === 'BILLING_DISABLED';
  return (
    <div className={`workspace studio-shell ${menu ? 'studio-menu-open' : ''}`}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar" id="studio-navigation">
        <div className="studio-brand">
          <Brand />
          <span>STUDIO</span>
        </div>
        <span className="sidebar-label">YOUR SPACE, IN FOCUS</span>
        <nav aria-label="Workspace">
          {destinations.map(({ to, title, icon: Icon }) => (
            <NavLink to={to} end={to === '/app'} key={to}>
              <Icon size={18} />
              {title}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="usage">
            <span>
              {moderator
                ? 'Organizer-covered event'
                : billingDisabled
                  ? 'Purchases not enabled'
                  : allowance.label}
            </span>
            {moderator ? (
              <p>
                The event owner covers uploads, processing and guest searches.
                Your personal packs are separate.
              </p>
            ) : billingDisabled ? (
              <p>
                Paid plans are not active on this installation. You can still
                view pricing and use available library features.
              </p>
            ) : allowance.available ? (
              <>
                <strong>
                  {remainingPhotos.toLocaleString()} photo attempts left
                </strong>
                <progress
                  aria-label="Photo processing allowance used"
                  max={Math.max(1, processed + remainingPhotos)}
                  value={processed}
                />
                <p>
                  {processed.toLocaleString()} processed /{' '}
                  {allowance.searchesRemaining.toLocaleString()} searches left
                </p>
                {allowance.storageBytesUsed != null && (
                  <p>
                    {(allowance.storageBytesUsed / 1e9).toFixed(2)} GB stored
                  </p>
                )}
              </>
            ) : (
              <p>
                {usage.isPending
                  ? 'Loading your allowance...'
                  : 'Usage unavailable. Open Billing to retry.'}
              </p>
            )}
            {!moderator && (
              <>
                {allowance.sharedLegacy && (
                  <p>
                    Includes shared legacy credits; balances are not additive.
                  </p>
                )}
                <Link
                  className="button compact sidebar-upgrade"
                  to={
                    billingDisabled
                      ? '/pricing'
                      : organizerContext
                        ? '/app/billing?context=organizer'
                        : '/app/billing'
                  }
                >
                  {billingDisabled
                    ? 'View pricing'
                    : organizerContext
                      ? 'Upgrade organizer plan'
                      : 'Upgrade / buy a pack'}{' '}
                  <ArrowUpRight size={15} />
                </Link>
              </>
            )}
            <p>
              {library.data
                ? `${library.data.storedPhotoCount ?? library.data.photos.length} photos in your account`
                : 'Your library is private.'}
            </p>
          </div>
          <div className="account">
            <span className="avatar">
              {query.data.name.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <strong>{query.data.name}</strong>
              <span>Your personal studio</span>
            </div>
            <button
              className="icon-button"
              aria-label="Sign out"
              disabled={loggingOut}
              onClick={() => void logout()}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="workspace-main">
        <header className="workspace-header">
          <div className="studio-breadcrumb">
            <button
              ref={toggle}
              className="icon-button studio-menu-toggle"
              aria-label="Toggle studio navigation"
              aria-expanded={menu}
              aria-controls="studio-navigation"
              onClick={() => setMenu(!menu)}
            >
              {menu ? <X size={20} /> : <Menu size={20} />}
            </button>
            <span>
              Studio <ChevronRight size={14} />
              <strong>{current}</strong>
            </span>
          </div>
          <div className="actions">
            <Link className="text-link" to="/">
              PicFind home <ArrowUpRight size={15} />
            </Link>
            <button
              className="icon-button mobile-signout"
              aria-label="Sign out on mobile"
              disabled={loggingOut}
              onClick={() => void logout()}
            >
              <LogOut size={17} />
            </button>
          </div>
        </header>
        <main id="main" className="workspace-content">
          <ErrorNote error={error} />
          <RouteContent />
        </main>
        <footer className="studio-footer">
          <span>PicFind Studio / Your moments, organized.</span>
          <nav aria-label="Studio footer">
            <Link to="/privacy">Privacy</Link>
            <Link to="/terms">Terms</Link>
          </nav>
        </footer>
      </div>
    </div>
  );
}
