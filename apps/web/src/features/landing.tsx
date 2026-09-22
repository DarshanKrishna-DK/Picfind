import { Link } from 'react-router';
import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  FolderOpen,
  LockKeyhole,
  QrCode,
  ScanFace,
  Smartphone,
} from 'lucide-react';
import { PhotoDepth } from '../components/photo-depth';
import { Pricing } from './pricing';

const questions = [
  [
    'Do I need an organizer to find my photos?',
    'No. Sign in and use Discover with a folder you can access, or photos in your personal library. You do not need to create an event. Personal processing uses one-time photo packs, not an organizer subscription. If you arrive through an event link, its organizer covers the event usage instead.',
  ],
  [
    'Will PicFind upload anything to my Google Drive?',
    'No. Drive is a read-only photo source. Results stay in PicFind until you choose to download them to your device. We do not create folders, export matches, or change your source files in Drive.',
  ],
  [
    'Can I download photos on my phone?',
    "Yes. Open a gallery in your browser, save an individual photo, or select photos to download together as a ZIP. Download all is also available. Your browser normally saves files to Downloads or the Files app; use your phone's share menu to save images to Photos.",
  ],
  [
    'What happens to my selfie?',
    'The matching service processes your reference photo to search the current collection. PicFind does not retain the search selfie. Matching is scoped to that search or event, not a global identity directory. Review the consent notice before searching.',
  ],
  [
    'Are matches guaranteed?',
    'No. Results are likely matches based on similarity, not proof of identity. Lighting, pose, blur, and face visibility affect results. Review the photos before sharing them.',
  ],
  [
    'Do guests need to install an app?',
    'No app or event purchase is needed. Open the secret event link or QR code in your browser and sign in to browse, download, or search with a selfie. Your organizer covers event usage. Some events also have a passcode. There is no public event directory.',
  ],
  [
    'Are downloads the original camera files?',
    'Uploads are optimized to JPEG at up to 3200 pixels, with embedded metadata removed. Downloads contain those optimized copies, not RAW files or guaranteed full-resolution originals. Keep your originals separately.',
  ],
  [
    'What are the current limits?',
    'PicFind is in a limited preview. The current development setup uses a 20-photo library and bounded discovery batches; the app displays the configured limits. ZIP downloads have a 64 MB safety limit to protect mobile memory. Choose a smaller selection if needed. Payments are not enabled.',
  ],
];

export function LandingPage() {
  return (
    <div className="launch-page">
      <section className="launch-hero wrap">
        <div className="launch-copy">
          <p className="launch-label">
            <span /> A LITTLE LESS SEARCHING. A LOT MORE YOU.
          </p>
          <h1>
            Your photos.
            <br />
            <span>Not the whole folder.</span>
          </h1>
          <p className="launch-intro">
            Find likely matches from a selfie. Keep your favorites in a simple
            gallery, right on your phone. Start with your own shared folder, or
            join an organizer's event.
          </p>
          <div className="launch-actions">
            <Link className="button" to="/app/discover/new">
              Find my photos <ArrowUpRight size={18} />
            </Link>
            <Link className="text-link" to="/app/events/new">
              Create an event <ArrowUpRight size={17} />
            </Link>
          </div>
          <p className="launch-reassurance">
            <LockKeyhole size={15} /> Read-only Drive access. No automatic
            exports.
          </p>
        </div>
        <PhotoDepth />
      </section>

      <section className="delivery-strip wrap" aria-label="What you can do">
        <span>
          <ScanFace size={19} /> Find your moments
        </span>
        <span>
          <Smartphone size={19} /> Browse on any screen
        </span>
        <span>
          <ArrowDownToLine size={19} /> Download to your device
        </span>
      </section>

      <section className="launch-feature wrap" id="discover">
        <div className="launch-section-copy">
          <p className="launch-label">01 / FOR YOU</p>
          <h2>
            The good ones.
            <br />
            Without the scrolling.
          </h2>
          <p>
            A shared folder can hold an entire occasion. Discover helps you find
            likely photos of yourself, then puts you in control of what to keep.
          </p>
          <Link className="button glass" to="/app/discover/new">
            Start with a folder <ArrowUpRight size={18} />
          </Link>
        </div>
        <ol className="launch-steps">
          <li>
            <span>01</span>
            <div>
              <h3>Connect your source</h3>
              <p>
                Use photos from your library or connect Google Drive and paste a
                folder you can access. Device, Dropbox, OneDrive and Box imports
                live together in your library when their connections are
                configured.
              </p>
            </div>
            <FolderOpen />
          </li>
          <li>
            <span>02</span>
            <div>
              <h3>Add a photo of yourself</h3>
              <p>
                Review the consent notice. Use a clear photo with one face for
                your search.
              </p>
            </div>
            <ScanFace />
          </li>
          <li>
            <span>03</span>
            <div>
              <h3>Choose what comes home</h3>
              <p>
                Preview the gallery. Save one photo, a selection, or all
                results. Nothing goes back to Drive.
              </p>
            </div>
            <ArrowDownToLine />
          </li>
        </ol>
      </section>

      <section className="organizer-band" id="events">
        <div className="launch-feature wrap">
          <div className="share-sculpture" aria-hidden="true">
            <div className="glass-sheet sheet-back">
              <FolderOpen strokeWidth={1} />
            </div>
            <div className="glass-sheet sheet-front">
              <QrCode strokeWidth={1.2} />
              <span>
                ONE LINK.
                <br />
                THE WHOLE OCCASION.
              </span>
            </div>
            <div className="metal-orbit" />
          </div>
          <div className="launch-section-copy">
            <p className="launch-label">02 / FOR YOUR EVENT</p>
            <h2>
              Share the day.
              <br />
              Skip the follow-ups.
            </h2>
            <p>
              Create a gallery, add your photos, and share a link or QR code.
              Your guests can browse and download in their browser, without
              installing an app.
            </p>
            <ul className="launch-checks">
              <li>
                <Check /> Private or shared, on your terms
              </li>
              <li>
                <Check /> Set an access expiry or archive the event
              </li>
              <li>
                <Check /> Guest favorites, passcodes and studio attribution
              </li>
            </ul>
            <Link className="button" to="/app/events/new">
              Create your gallery <ArrowUpRight size={18} />
            </Link>
          </div>
        </div>
      </section>

      <section className="device-delivery wrap">
        <div className="launch-section-copy">
          <p className="launch-label">YOURS TO KEEP</p>
          <h2>
            A gallery.
            <br />
            Not another destination.
          </h2>
          <p>
            No surprise exports. No new folders in your Drive. Download the
            photos you choose straight to your device.
          </p>
        </div>
        <div className="download-methods">
          <article>
            <ArrowDownToLine />
            <h3>Just this one</h3>
            <p>Open a photo and download it directly.</p>
          </article>
          <article>
            <Check />
            <h3>Your favorites</h3>
            <p>Select across the gallery and save a ZIP.</p>
          </article>
          <article>
            <FolderOpen />
            <h3>The whole gallery</h3>
            <p>One download action. All available photos.</p>
          </article>
          <p className="download-footnote">
            Optimized JPEG copies. ZIPs up to 64 MB. On mobile, look in Files or
            Downloads.
          </p>
        </div>
      </section>

      <section
        className="collection-comparison wrap"
        aria-labelledby="collection-choice"
      >
        <div className="launch-section-copy">
          <p className="launch-label">EXISTING PHOTOS. A BETTER WAY THROUGH.</p>
          <h2 id="collection-choice">More than a shared folder.</h2>
          <p>
            Start with photos you already have, or give your next event a home.
            Discovery and delivery belong in the same place.
          </p>
        </div>
        <div className="comparison-scroll">
          <table>
            <caption>
              Shared-folder workflow compared with PicFind's discovery and
              delivery workflow
            </caption>
            <thead>
              <tr>
                <th scope="col">The everyday task</th>
                <th scope="col">A shared folder</th>
                <th scope="col">With PicFind</th>
              </tr>
            </thead>
            <tbody>
              {[
                [
                  'Find your photos without hosting an event',
                  'Browse the folder you received',
                  'Personal Discover with one-time packs; no organizer subscription needed',
                ],
                [
                  'Find photos of yourself',
                  'Browse the collection manually',
                  'Search a consented collection with a selfie',
                ],
                [
                  'Start with an existing album',
                  'Keep photos at the source',
                  'Read-only discovery or import; no automatic exports back',
                ],
                [
                  'Deliver an event',
                  'Share access to a folder',
                  'A mobile gallery, guest favorites, passcode and QR sharing',
                ],
                [
                  'Let guests find their moments',
                  'Send instructions and handle photo requests',
                  'Guests sign in through the event link; organizer allowances cover their searches',
                ],
                [
                  'Choose what to save',
                  'Manage files in the source app',
                  'Preview and download one, selected photos or all',
                ],
              ].map((row) => (
                <tr key={row[0]}>
                  {row.map((cell, index) =>
                    index === 0 ? (
                      <th scope="row" key={cell}>
                        {cell}
                      </th>
                    ) : (
                      <td key={cell}>{cell}</td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="field-help">
          Photo matching returns likely matches, not proof of identity. Source
          connections require authorization. Downloads are optimized JPEG
          copies.
        </p>
      </section>
      <Pricing embedded />
      <section className="launch-faq wrap" id="faq">
        <div>
          <p className="launch-label">A FEW GOOD QUESTIONS</p>
          <h2>
            Before you
            <br />
            jump in.
          </h2>
          <Link className="text-link" to="/privacy">
            Read the privacy notice <ArrowUpRight size={17} />
          </Link>
        </div>
        <div>
          {questions.map(([question, answer]) => (
            <details key={question} name="picfind-faq">
              <summary>
                {question}
                <span aria-hidden="true">+</span>
              </summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </section>
      <section className="launch-closing wrap">
        <h2>
          Your next favorite
          <br />
          is somewhere in that folder.
        </h2>
        <Link className="button" to="/app/discover/new">
          Find my photos <ArrowUpRight size={18} />
        </Link>
      </section>
    </div>
  );
}
