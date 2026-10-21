import { Link, Navigate, Route, Routes } from 'react-router';
import { ArrowRight } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { Loading } from './components/ui';
import { PublicLayout } from './features/public-layout';
import { LandingPage } from './features/landing';
import { Workspace } from './features/workspace';

const Information = lazy(() =>
  import('./features/public').then((m) => ({ default: m.Information })),
);
const Dashboard = lazy(() =>
  import('./features/dashboard').then((m) => ({ default: m.Dashboard })),
);
const EventList = lazy(() =>
  import('./components/event-list').then((m) => ({ default: m.EventList })),
);
const SignIn = lazy(() =>
  import('./features/auth').then((m) => ({ default: m.SignIn })),
);
const RecoveryPage = lazy(() =>
  import('./features/recovery').then((m) => ({ default: m.RecoveryPage })),
);
const LibraryPage = lazy(() =>
  import('./features/gallery').then((m) => ({ default: m.LibraryPage })),
);
const ImportPage = lazy(() =>
  import('./features/gallery').then((m) => ({ default: m.ImportPage })),
);
const DiscoverPage = lazy(() =>
  import('./features/discover').then((m) => ({ default: m.DiscoverPage })),
);
const NewEvent = lazy(() =>
  import('./features/events').then((m) => ({ default: m.NewEvent })),
);
const EventDetail = lazy(() =>
  import('./features/events').then((m) => ({ default: m.EventDetail })),
);
const SharedEvent = lazy(() =>
  import('./features/events').then((m) => ({ default: m.SharedEvent })),
);
const SettingsPage = lazy(() =>
  import('./features/account').then((m) => ({ default: m.SettingsPage })),
);
const BillingPage = lazy(() =>
  import('./features/billing').then((m) => ({ default: m.BillingPage })),
);
const InvitedCollectionPage = lazy(() =>
  import('./features/collection-invitations').then((m) => ({
    default: m.InvitedCollectionPage,
  })),
);
const HighlightsPage = lazy(() =>
  import('./features/highlights').then((m) => ({ default: m.HighlightsPage })),
);
const HighlightWall = lazy(() =>
  import('./features/highlight-wall').then((m) => ({
    default: m.HighlightWall,
  })),
);
const StudioClients = lazy(() =>
  import('./features/studio-clients').then((m) => ({
    default: m.StudioClients,
  })),
);
const PhotographerCredits = lazy(() =>
  import('./features/credit-presets').then((m) => ({
    default: m.PhotographerCredits,
  })),
);
const StudioEnquiries = lazy(() =>
  import('./features/studio-enquiries').then((m) => ({
    default: m.StudioEnquiries,
  })),
);
const PublicEnquiry = lazy(() =>
  import('./features/studio-enquiries').then((m) => ({
    default: m.PublicEnquiry,
  })),
);
const StudioServices = lazy(() =>
  import('./features/studio-services').then((m) => ({
    default: m.StudioServices,
  })),
);
const StudioExpenses = lazy(() =>
  import('./features/studio-expenses').then((m) => ({
    default: m.StudioExpenses,
  })),
);
const ProjectBudgets = lazy(() =>
  import('./features/project-budgets').then((m) => ({
    default: m.ProjectBudgets,
  })),
);
const ProjectProductionBrief = lazy(() =>
  import('./features/project-brief').then((m) => ({
    default: m.ProjectProductionBrief,
  })),
);
const StudioEnquiryReport = lazy(() =>
  import('./features/enquiry-report').then((m) => ({
    default: m.StudioEnquiryReport,
  })),
);
const EventDeadlines = lazy(() =>
  import('./features/event-deadlines').then((m) => ({
    default: m.EventDeadlines,
  })),
);
const EnquiryProjectHandoff = lazy(() =>
  import('./features/enquiry-handoff').then((m) => ({
    default: m.EnquiryProjectHandoff,
  })),
);
const StudioPortfolio = lazy(() =>
  import('./features/studio-portfolio').then((m) => ({
    default: m.StudioPortfolio,
  })),
);
const PublicPhotographerPortfolio = lazy(() =>
  import('./features/studio-portfolio').then((m) => ({
    default: m.PublicPhotographerPortfolio,
  })),
);
const StudioProjects = lazy(() =>
  import('./features/studio-projects').then((m) => ({
    default: m.StudioProjects,
  })),
);
const ProjectQuestionnaires = lazy(() =>
  import('./features/project-questionnaires').then((m) => ({
    default: m.ProjectQuestionnaires,
  })),
);
const ProjectProposals = lazy(() =>
  import('./features/project-proposals').then((m) => ({
    default: m.ProjectProposals,
  })),
);
const StudioWork = lazy(() =>
  import('./features/studio-work').then((m) => ({ default: m.StudioWork })),
);
const StudioSchedule = lazy(() =>
  import('./features/studio-schedule').then((m) => ({
    default: m.StudioSchedule,
  })),
);
const StudioAvailability = lazy(() =>
  import('./features/studio-availability').then((m) => ({
    default: m.StudioAvailability,
  })),
);
const DuplicateReview = lazy(() =>
  import('./features/duplicate-review').then((m) => ({
    default: m.DuplicateReview,
  })),
);
const PublishedInvitationPage = lazy(() =>
  import('./features/event-invitation-page').then((m) => ({
    default: m.PublishedInvitationPage,
  })),
);
const GuestRsvpPage = lazy(() =>
  import('./features/guest-rsvp').then((m) => ({ default: m.GuestRsvpPage })),
);

export function Product() {
  return (
    <Routes>
      <Route
        path="highlights/:eventId/wall"
        element={
          <Suspense fallback={<Loading />}>
            <HighlightWall />
          </Suspense>
        }
      />
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
        <Route path="invite/:eventId" element={<PublishedInvitationPage />} />
        <Route path="invite/:eventId/response" element={<GuestRsvpPage />} />
        <Route path="enquire/:id" element={<PublicEnquiry />} />
        <Route path="portfolio/:id" element={<PublicPhotographerPortfolio />} />
        <Route path="highlights/:eventId" element={<HighlightsPage />} />
        <Route path="proposals/:id" element={<ProjectProposals client />} />
        <Route
          path="questionnaires/:id"
          element={<ProjectQuestionnaires client />}
        />
        <Route
          path="proofing/:invitationId"
          element={<InvitedCollectionPage />}
        />
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
        <Route path="clients" element={<StudioClients />} />
        <Route path="services" element={<StudioServices />} />
        <Route path="expenses" element={<StudioExpenses />} />
        <Route path="event-deadlines" element={<EventDeadlines />} />
        <Route path="portfolio" element={<StudioPortfolio />} />
        <Route path="credits" element={<PhotographerCredits />} />
        <Route path="enquiries" element={<StudioEnquiries />} />
        <Route path="enquiry-report" element={<StudioEnquiryReport />} />
        <Route
          path="enquiries/:id/handoff"
          element={<EnquiryProjectHandoff />}
        />
        <Route path="projects" element={<StudioProjects />} />
        <Route path="projects/:projectId/budget" element={<ProjectBudgets />} />
        <Route
          path="projects/:projectId/brief"
          element={<ProjectProductionBrief />}
        />
        <Route
          path="projects/:projectId/proposals"
          element={<ProjectProposals />}
        />
        <Route
          path="projects/:projectId/questionnaires"
          element={<ProjectQuestionnaires />}
        />
        <Route path="work" element={<StudioWork />} />
        <Route path="schedule" element={<StudioSchedule />} />
        <Route path="availability" element={<StudioAvailability />} />
        <Route path="duplicates" element={<DuplicateReview />} />
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
