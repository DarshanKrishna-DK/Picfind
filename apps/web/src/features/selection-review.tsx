import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Download, X } from 'lucide-react';
import { api, fileUrl, HttpError, saveFile } from '../api';
import { ErrorNote } from '../components/ui';
import { collectPhotoFiles, createGalleryArchive } from '../gallery-downloads';
import {
  SELECTION_STATUSES,
  type EventSelection,
  type SelectionReview,
  type SelectionStatus,
} from '../../../../packages/shared/src/proofing';
import './organizer.css';

const labels: Record<SelectionStatus, string> = {
  new: 'New',
  'in-progress': 'In progress',
  completed: 'Completed',
};

export function SelectionInbox({
  eventId,
  selections,
  refresh,
}: {
  eventId: string;
  selections: EventSelection[];
  refresh: () => Promise<EventSelection[]>;
}) {
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const visible = selections
    .filter(
      (selection) =>
        (status === 'all' || (selection.reviewStatus ?? 'new') === status) &&
        `${selection.name} ${selection.note}`
          .toLocaleLowerCase()
          .includes(search.trim().toLocaleLowerCase()),
    )
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
    );
  return (
    <section className="selection-inbox" aria-label="Client selection inbox">
      <div className="selection-inbox-heading">
        <div>
          <p className="eyebrow">FROM FAVORITES TO FINISHED</p>
          <h3>Client selection inbox</h3>
        </div>
        <span>
          {
            selections.filter(
              (selection) => (selection.reviewStatus ?? 'new') !== 'completed',
            ).length
          }{' '}
          awaiting completion
        </span>
      </div>
      <p>
        Track editing and album requests here. Status and review notes stay
        private; saving a review does not send a message or change the guest
        gallery.
      </p>
      <div className="selection-filters">
        <label>
          Search selections
          <input
            type="search"
            maxLength={120}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Guest name or request"
          />
        </label>
        <label>
          Filter selection status
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="all">All requests</option>
            {SELECTION_STATUSES.map((value) => (
              <option value={value} key={value}>
                {labels[value]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p role="status">
        {visible.length} of {selections.length} requests
      </p>
      {!visible.length && (
        <p className="notice">
          {selections.length
            ? 'No requests match these filters.'
            : 'No favorites yet. Guests can send selections from your shared gallery.'}
        </p>
      )}
      {visible.map((selection) => (
        <SelectionCard
          key={selection.id}
          eventId={eventId}
          selection={selection}
          refresh={refresh}
        />
      ))}
    </section>
  );
}

function SelectionCard({
  eventId,
  selection,
  refresh,
}: {
  eventId: string;
  selection: EventSelection;
  refresh: () => Promise<EventSelection[]>;
}) {
  const [base, setBase] = useState(selection);
  const [status, setStatus] = useState<SelectionStatus>(
    selection.reviewStatus ?? 'new',
  );
  const [note, setNote] = useState(selection.reviewNote ?? '');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const stale =
    conflict || (selection.reviewVersion ?? 0) !== (base.reviewVersion ?? 0);
  const photos = selection.photos ?? [];
  const missing = selection.photoIds.length - photos.length;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || stale) return;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      const result = await api<{ review: SelectionReview }>(
        `/events/${eventId}/selections/${selection.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            reviewStatus: status,
            reviewNote: note,
            version: base.reviewVersion ?? 0,
          }),
        },
      );
      setBase({ ...base, ...result.review });
      setStatus(result.review.reviewStatus);
      setNote(result.review.reviewNote);
      setMessage('Review saved. No message was sent to the guest.');
      await refresh();
    } catch (failure) {
      setError(failure);
      if (failure instanceof HttpError && failure.code === 'REVIEW_CHANGED')
        setConflict(true);
    } finally {
      setBusy(false);
    }
  }

  async function reload() {
    setBusy(true);
    setError(null);
    try {
      const latest = (await refresh()).find((row) => row.id === selection.id);
      if (!latest)
        throw new Error(
          'This selection is no longer available. Refresh the event.',
        );
      setBase(latest);
      setStatus(latest.reviewStatus);
      setNote(latest.reviewNote);
      setConflict(false);
      setMessage('Latest review loaded. You can edit and save again.');
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    if (controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setDownloading(true);
    setError(null);
    setProgress('Preparing your download...');
    try {
      const files = await collectPhotoFiles(
        photos.map((photo) => ({ ...photo, url: fileUrl(photo.id) })),
        abort.signal,
        (done, total) => setProgress(`Preparing ${done} of ${total} photos...`),
      );
      const bytes = await createGalleryArchive(files, abort.signal);
      abort.signal.throwIfAborted();
      saveFile(
        new Blob([new Uint8Array(bytes)], { type: 'application/zip' }),
        `picfind-selection-${selection.id}.zip`,
      );
      setProgress('ZIP ready. Your device handles the download.');
    } catch (failure) {
      if (abort.signal.aborted) setProgress('Download cancelled.');
      else {
        setProgress('');
        setError(failure);
      }
    } finally {
      controller.current = null;
      setDownloading(false);
    }
  }

  return (
    <article
      className="selection-card"
      aria-label={`Selection from ${selection.name}`}
    >
      <div className="selection-card-heading">
        <div>
          <h4>{selection.name}</h4>
          <p>
            {selection.photoIds.length} favorites /{' '}
            <time dateTime={selection.createdAt}>
              {new Date(selection.createdAt).toLocaleDateString()}
            </time>
          </p>
        </div>
        <span
          className={`review-badge review-${selection.reviewStatus ?? 'new'}`}
        >
          {labels[selection.reviewStatus ?? 'new']}
        </span>
      </div>
      {selection.note && <blockquote>{selection.note}</blockquote>}
      <div className="selection-thumbnails">
        {photos.map((photo) => (
          <a
            href={fileUrl(photo.id)}
            target="_blank"
            rel="noreferrer"
            key={photo.id}
            aria-label={`Open ${photo.filename}`}
          >
            <img
              src={fileUrl(photo.id)}
              alt={photo.filename}
              width={80}
              height={80}
              loading="lazy"
            />
          </a>
        ))}
      </div>
      {missing > 0 && (
        <p className="notice">
          {missing} selected {missing === 1 ? 'photo is' : 'photos are'} no
          longer available. Downloads include only the {photos.length} remaining
          photos.
        </p>
      )}
      <div className="source-actions">
        <button
          className="button secondary"
          disabled={downloading || !photos.length}
          onClick={() => void download()}
        >
          <Download size={16} />
          Download favorites ZIP
        </button>
        {downloading && (
          <button
            className="button secondary"
            onClick={() => controller.current?.abort()}
          >
            <X size={16} />
            Cancel download
          </button>
        )}
      </div>
      <p className="field-help">
        Device download only, up to 64 MB per ZIP. For larger requests, open and
        save individual photos above. Delivery allowance applies.
      </p>
      <p role="status">{progress}</p>
      <form onSubmit={(event) => void save(event)}>
        <div className="selection-review-fields">
          <label>
            Review status
            <select
              value={status}
              disabled={busy}
              onChange={(event) =>
                setStatus(event.target.value as SelectionStatus)
              }
            >
              {SELECTION_STATUSES.map((value) => (
                <option value={value} key={value}>
                  {labels[value]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Private review note
            <textarea
              value={note}
              maxLength={2000}
              rows={3}
              disabled={busy}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Editing notes, album progress or next steps"
            />
          </label>
        </div>
        <ErrorNote error={error} />
        {stale && (
          <div className="notice">
            <p>
              A newer review is available. Loading it replaces your unsaved
              status and note; copy anything you want to keep first.
            </p>
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => void reload()}
            >
              Load latest review
            </button>
          </div>
        )}
        <button className="button secondary" disabled={busy || stale}>
          {busy ? 'Saving...' : 'Save review'}
        </button>
        <p role="status">{message}</p>
      </form>
    </article>
  );
}
