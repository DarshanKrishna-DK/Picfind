import { Link } from 'react-router';
import { ArrowRight } from 'lucide-react';

export function Information({
  page,
}: {
  page: 'privacy' | 'terms' | 'contact';
}) {
  return (
    <section className="wrap standalone reading">
      <p className="eyebrow">PICFIND / {page.toUpperCase()}</p>
      <h1>
        {page === 'privacy'
          ? 'Your memories. Your choice.'
          : page === 'terms'
            ? 'A thoughtful place for photos.'
            : 'Keep in touch.'}
      </h1>
      {page === 'privacy' ? (
        <>
          <h2>What this build stores</h2>
          <p>
            Account name, email address, event details, import status, optimized
            photographs, and file metadata are stored using Appwrite. Account
            passwords are handled by Appwrite authentication. Sessions use an
            HttpOnly cookie.
          </p>
          <h2>Cloud connections</h2>
          <p>
            Cloud access is read-only: results are never written back to Google
            Drive, Dropbox, OneDrive or Box. Where persistent connections are
            enabled, access and refresh grants are encrypted in private
            server-side storage. Disconnecting removes PicFind's stored grant;
            account deletion removes connection records. You can also revoke
            PicFind in your cloud provider's account settings. Other deployments
            use temporary secure browser cookies. Your import screen explains
            which mode is active.
          </p>
          <h2>Photographs and sharing</h2>
          <p>
            Photo uploads are re-encoded as JPEG, with embedded metadata removed
            and dimensions limited to 3200 pixels. Original files are not
            retained. Discover and event search can process a consented
            reference photo through Amazon Rekognition. PicFind does not retain
            the search selfie. Provider face indexes and match results are
            scoped to the event or search session, not a global identity
            directory.
          </p>
          <p>
            Your library is private. Enabling an event link makes every photo in
            that event accessible to anyone with the link. Turning sharing off
            or archiving the event prevents further access through that link but
            cannot recall downloads already made.
          </p>
          <h2>Deletion and retention</h2>
          <p>
            Delete photographs from their detail view, or delete an event and
            its photographs from event settings. Export library metadata from
            account settings. Account deletion is available in Settings.
            Scheduled retention and backup-erasure verification still need
            production validation. An event's access expiry is not the same as
            deleting its stored photographs.
          </p>
          <h2>Development notice</h2>
          <p>
            This is implementation information, not a launch-approved privacy
            policy. The service is not ready for a public production launch.
          </p>
        </>
      ) : page === 'terms' ? (
        <>
          <h2>Use photographs you have permission to share</h2>
          <p>
            Upload only images you own or have permission to use. Obtain
            permission before publishing photographs of other people. Do not
            upload sensitive documents or unlawful content.
          </p>
          <h2>Keep your original files</h2>
          <p>
            PicFind stores optimized images, not original files. This
            development service is not a backup provider. Keep a separate copy
            of your photographs.
          </p>
          <h2>Development availability</h2>
          <p>
            Your Studio shows the photo, processing and storage allowances for
            this deployment. Development builds may use lower safety limits.
            Checkout availability depends on the deployment's payment setup.
            Service-level guarantees and launch-approved commercial terms are
            not available in this development release.
          </p>
        </>
      ) : (
        <>
          <p className="lede">
            A support channel has not been configured for this development
            release.
          </p>
          <p>
            If you are testing PicFind, report problems to the person who
            provided your installation. Include what you were doing and the
            error message, without sharing passwords or private photos.
          </p>
          <Link className="button" to="/app">
            Return to your library <ArrowRight size={17} />
          </Link>
        </>
      )}
    </section>
  );
}
