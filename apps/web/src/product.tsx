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
import { InvitedCollectionPage } from './features/collection-invitations';
import { HighlightsPage } from './features/highlights';
import { HighlightWall } from './features/highlight-wall';
import { StudioClients } from './features/studio-clients';
import { PhotographerCredits } from './features/credit-presets';
import { StudioEnquiries, PublicEnquiry } from './features/studio-enquiries';
import { StudioServices } from './features/studio-services';
import { StudioExpenses } from './features/studio-expenses';
import { ProjectBudgets } from './features/project-budgets';
import { ProjectProductionBrief } from './features/project-brief';
import { StudioEnquiryReport } from './features/enquiry-report';
import { EventDeadlines } from './features/event-deadlines';
import { EnquiryProjectHandoff } from './features/enquiry-handoff';
import {
  StudioPortfolio,
  PublicPhotographerPortfolio,
} from './features/studio-portfolio';
import { StudioProjects } from './features/studio-projects';
import { ProjectQuestionnaires } from './features/project-questionnaires';
import { ProjectProposals } from './features/project-proposals';
import { StudioWork } from './features/studio-work';
import { StudioSchedule } from './features/studio-schedule';
import { DuplicateReview } from './features/duplicate-review';
import { PublishedInvitationPage } from './features/event-invitation-page';
import { GuestRsvpPage } from './features/guest-rsvp';
import './features/billing.css';

export function Product() {
  return (
    <Routes>
      <Route path="highlights/:eventId/wall" element={<HighlightWall />} />
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
