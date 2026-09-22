import { Link, Navigate, Route, Routes } from 'react-router';
import { ArrowRight } from 'lucide-react';
import { Information } from './features/public';
import { PublicLayout } from './features/public-layout';
import { Dashboard } from './features/dashboard';
import { LandingPage } from './features/landing';
import { EventList } from './components/event-list';
import { SignIn } from './features/auth';
import { RecoveryPage } from './features/recovery';
import { Workspace } from './features/workspace';
import { LibraryPage, ImportPage } from './features/gallery';
import { DiscoverPage } from './features/discover';
import { NewEvent, EventDetail, SharedEvent } from './features/events';
import { SettingsPage } from './features/account';
import { BillingPage } from './features/billing';
import './features/billing.css';

export function Product() {
  return (
    <Routes>
      <Route element={<PublicLayout />}>
        <Route index element={<LandingPage />} />
        <Route path="discover" element={<Navigate to="/#discover" replace />} />
        <Route path="events" element={<Navigate to="/#events" replace />} />
        <Route path="pricing" element={<Navigate to="/#pricing" replace />} />
        <Route path="sign-in" element={<SignIn />} />
        <Route
          path="forgot-password"
          element={<RecoveryPage key="request" mode="request" />}
        />
        <Route
          path="reset-password"
          element={<RecoveryPage key="reset" mode="reset" />}
        />
        <Route
          path="verify-email"
          element={<RecoveryPage key="verify" mode="verify" />}
        />
        <Route path="privacy" element={<Information page="privacy" />} />
        <Route path="terms" element={<Information page="terms" />} />
        <Route path="contact" element={<Information page="contact" />} />
        <Route path="e/:eventId" element={<SharedEvent />} />
        <Route
          path="*"
          element={
            <section className="wrap standalone">
              <h1>A little off the beaten path.</h1>
              <p>This page does not exist.</p>
              <Link className="button" to="/">
                Return home <ArrowRight size={18} />
              </Link>
            </section>
          }
        />
      </Route>
      <Route path="app" element={<Workspace />}>
        <Route index element={<Dashboard />} />
        <Route path="library" element={<LibraryPage />} />
        <Route path="events" element={<EventList />} />
        <Route path="events/new" element={<NewEvent />} />
        <Route path="events/:eventId" element={<EventDetail />} />
        <Route path="import" element={<ImportPage />} />
        <Route path="discover/new" element={<DiscoverPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="billing" element={<BillingPage />} />
        <Route
          path="*"
          element={
            <section className="glass-panel">
              <h1>This studio page is unavailable.</h1>
              <Link className="button" to="/app">
                Back to overview
              </Link>
            </section>
          }
        />
      </Route>
    </Routes>
  );
}
