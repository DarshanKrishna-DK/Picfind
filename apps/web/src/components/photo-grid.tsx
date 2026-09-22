import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownToLine,
  Check,
  ChevronLeft,
  ChevronRight,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import { api, fileUrl, type Photo } from '../api';
import { collectPhotoFiles, createGalleryArchive } from '../gallery-downloads';
import { Empty, ErrorNote } from './ui';
import { MenuSelect } from './menu-select';

export function PhotoGrid({
  photos,
  eventId,
  readOnly = false,
  preserveOrder = false,
}: {
  photos: Photo[];
  eventId?: string;
  readOnly?: boolean;
  preserveOrder?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState(preserveOrder ? 'source' : 'newest');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detailId, setDetailId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [status, setStatus] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [downloadUrl, setDownloadUrl] = useState('');
  const [downloadName, setDownloadName] = useState('picfind-photos.zip');
  const dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef<AbortController | null>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const client = useQueryClient();
  const filtered = photos
    .filter((photo) =>
      photo.filename.toLowerCase().includes(search.trim().toLowerCase()),
    )
    .sort((a, b) => {
      if (sort === 'source') return 0;
      if (sort === 'name') return a.filename.localeCompare(b.filename);
      if (sort === 'oldest') return a.createdAt.localeCompare(b.createdAt);
      return b.createdAt.localeCompare(a.createdAt);
    });
  const picked = photos.filter((photo) => selected.has(photo.id));
  const detail = filtered.find((photo) => photo.id === detailId);
  const detailIndex = filtered.findIndex((photo) => photo.id === detailId);
  const allVisibleSelected =
    filtered.length > 0 && filtered.every((photo) => selected.has(photo.id));

  useEffect(() => {
    if (detail && !dialog.current?.open) dialog.current?.showModal();
    if (!detail && dialog.current?.open) dialog.current.close();
  }, [detail]);
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  useEffect(
    () => () => {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    },
    [downloadUrl],
  );

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function move(direction: number) {
    const next = filtered[detailIndex + direction];
    if (next) setDetailId(next.id);
  }
  async function download(items: Photo[], asArchive = true) {
    if (controller.current || !items.length) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError(null);
    setDownloadUrl('');
    setStatus('Preparing your device download...');
    setProgress({ completed: 0, total: items.length });
    try {
      const files = await collectPhotoFiles(
        items.map((photo) => ({ ...photo, url: fileUrl(photo.id, eventId) })),
        request.signal,
        (completed, total) => {
          setProgress({ completed, total });
          setStatus(`Preparing ${completed} of ${total} photos...`);
        },
      );
      const bytes = asArchive
        ? await createGalleryArchive(files, request.signal)
        : Object.values(files)[0]!;
      const filename = asArchive
        ? 'picfind-photos.zip'
        : Object.keys(files)[0]!;
      request.signal.throwIfAborted();
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(bytes)], {
          type: asArchive ? 'application/zip' : 'image/jpeg',
        }),
      );
      setDownloadUrl(url);
      setDownloadName(filename);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setStatus(
        `${items.length} ${items.length === 1 ? 'photo is' : 'photos are'} ready. If your download did not open, use Save download below.`,
      );
    } catch (failure) {
      if (request.signal.aborted)
        setStatus('Download cancelled. You can try again.');
      else {
        setError(failure);
        setStatus('');
      }
    } finally {
      controller.current = null;
      setBusy(false);
    }
  }
  async function remove() {
    if (
      !detail ||
      deleting ||
      !window.confirm('Permanently delete this photo from PicFind?')
    )
      return;
    setDeleting(true);
    setError(null);
    try {
      const result = await api<{ deletion?: string } | undefined>(
        `/photos/${detail.id}`,
        { method: 'DELETE' },
      );
      const deletedId = detail.id;
      setSelected(
        (current) => new Set([...current].filter((id) => id !== deletedId)),
      );
      dialog.current?.close();
      setDetailId(null);
      await client.invalidateQueries({ queryKey: ['library'] });
      setStatus(
        result?.deletion === 'pending'
          ? 'Photo hidden. Cloud cleanup is pending and will retry automatically. Your source file is unchanged.'
          : 'Photo deleted from PicFind. Your source file is unchanged.',
      );
    } catch (failure) {
      setError(failure);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="gallery-experience">
      <div className="gallery-toolbar">
        <label className="search-input">
          <Search size={18} />
          <input
            aria-label="Search photos by filename"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search filenames"
          />
          {search && (
            <button
              type="button"
              className="icon-button"
              aria-label="Clear photo search"
              onClick={() => setSearch('')}
            >
              <X size={16} />
            </button>
          )}
        </label>
        <label className="sort-select">
          <SlidersHorizontal size={16} />
          <MenuSelect
            label="Sort photos"
            value={sort}
            onChange={setSort}
            options={[
              ...(preserveOrder
                ? [{ value: 'source', label: 'Result order' }]
                : []),
              { value: 'newest', label: 'Recently added' },
              { value: 'oldest', label: 'Oldest first' },
              { value: 'name', label: 'Filename' },
            ]}
          />
        </label>
        <button
          className="button secondary compact"
          disabled={!filtered.length}
          onClick={() =>
            setSelected((current) => {
              const next = new Set(current);
              for (const photo of filtered) {
                if (allVisibleSelected) next.delete(photo.id);
                else next.add(photo.id);
              }
              return next;
            })
          }
        >
          {allVisibleSelected ? 'Deselect visible' : 'Select all'}
        </button>
        <button
          className="button compact"
          disabled={!photos.length || busy}
          onClick={() => void download(photos)}
        >
          <ArrowDownToLine size={16} />
          Download all
        </button>
      </div>
      <div className="gallery-summary">
        <span>
          {search
            ? `${filtered.length} of ${photos.length} photos`
            : `${photos.length} photos`}
        </span>
        <span>Downloads stay on your device</span>
      </div>
      {!!photos.length && (
        <div
          className={`selection-bar gallery-selection ${picked.length ? '' : 'no-selection'}`}
        >
          <span>
            <Check size={16} />
            {picked.length} selected
          </span>
          <div className="actions">
            <button
              className="text-link"
              disabled={!picked.length}
              onClick={() => setSelected(new Set())}
            >
              Clear selection
            </button>
            <button
              className="button compact"
              disabled={busy || !picked.length}
              onClick={() => void download(picked)}
            >
              <ArrowDownToLine size={16} />
              Download selected
            </button>
          </div>
        </div>
      )}
      {busy && (
        <div className="download-progress">
          <progress
            aria-label="Download preparation"
            value={progress.completed}
            max={progress.total || 1}
          />
          <button
            className="button secondary compact"
            onClick={() => controller.current?.abort()}
          >
            Cancel download
          </button>
        </div>
      )}
      <ErrorNote error={error} />
      <p className="upload-status" role="status" aria-live="polite">
        {status}
      </p>
      {downloadUrl && (
        <a
          className="button secondary compact"
          href={downloadUrl}
          download={downloadName}
        >
          <ArrowDownToLine size={17} />
          Save download
        </a>
      )}
      {!!photos.length && (
        <details className="download-help">
          <summary>Where do downloads go on my phone?</summary>
          <p>
            Photos and ZIP files are saved through your browser. On iPhone,
            check Files and its Downloads folder, then use Share to save an
            image to Photos. On Android, check Downloads or Files. Nothing is
            exported to Google Drive. A ZIP contains optimized JPEG copies; keep
            your original files separately.
          </p>
        </details>
      )}
      {!filtered.length ? (
        <Empty
          title={
            photos.length
              ? 'No photos with that name.'
              : 'Your gallery is ready for photos.'
          }
          text={
            photos.length
              ? 'Try another filename or clear the search.'
              : readOnly
                ? 'The organizer has not added photographs to this gallery yet.'
                : 'Add photos from your device to start your gallery.'
          }
        >
          {search && (
            <button className="button secondary" onClick={() => setSearch('')}>
              Clear search
            </button>
          )}
        </Empty>
      ) : (
        <div className="photo-grid">
          {filtered.map((photo) => (
            <article
              className={
                selected.has(photo.id) ? 'photo-tile selected' : 'photo-tile'
              }
              key={photo.id}
            >
              <button
                className="photo-open"
                onClick={() => setDetailId(photo.id)}
                aria-label={`Open ${photo.filename}`}
              >
                <img
                  loading="lazy"
                  decoding="async"
                  src={fileUrl(photo.id, eventId)}
                  alt={photo.filename}
                  width={photo.width || 800}
                  height={photo.height || 600}
                />
              </button>
              <div className="photo-caption">
                <label>
                  <input
                    type="checkbox"
                    checked={selected.has(photo.id)}
                    onChange={() => toggle(photo.id)}
                    aria-label={`Select ${photo.filename}`}
                  />
                  <span title={photo.filename}>{photo.filename}</span>
                </label>
                <a
                  className="icon-button"
                  aria-label={`Download ${photo.filename}`}
                  href={`${fileUrl(photo.id, eventId)}?download=1`}
                  aria-disabled={busy}
                  onClick={(event) => {
                    event.preventDefault();
                    void download([photo], false);
                  }}
                  download
                >
                  <ArrowDownToLine size={18} />
                </a>
              </div>
              {photo.expiresAt && (
                <p className="photo-expiry">
                  Available until{' '}
                  <time
                    dateTime={photo.expiresAt}
                    title={new Date(photo.expiresAt).toLocaleString()}
                  >
                    {new Date(photo.expiresAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </time>
                </p>
              )}
            </article>
          ))}
        </div>
      )}
      <dialog
        ref={dialog}
        className="photo-dialog gallery-viewer"
        aria-label="Photo viewer"
        onClose={() => setDetailId(null)}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            move(-1);
          }
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            move(1);
          }
        }}
      >
        {detail && (
          <>
            <div className="dialog-top">
              <h2>{detail.filename}</h2>
              <button
                className="icon-button"
                autoFocus
                aria-label="Close photo"
                onClick={() => dialog.current?.close()}
              >
                <X />
              </button>
            </div>
            <div
              className="viewer-image"
              onTouchStart={(event) => {
                const first = event.touches[0];
                touch.current =
                  event.touches.length === 1 && first
                    ? { x: first.clientX, y: first.clientY }
                    : null;
              }}
              onTouchEnd={(event) => {
                const end = event.changedTouches[0];
                if (end && touch.current) {
                  const dx = end.clientX - touch.current.x;
                  const dy = end.clientY - touch.current.y;
                  if (Math.abs(dx) > 65 && Math.abs(dx) > Math.abs(dy) * 1.5)
                    move(dx > 0 ? -1 : 1);
                }
                touch.current = null;
              }}
            >
              <img src={fileUrl(detail.id, eventId)} alt={detail.filename} />
            </div>
            <div className="viewer-navigation">
              <button
                className="icon-button"
                aria-label="Previous photo"
                disabled={detailIndex <= 0}
                onClick={() => move(-1)}
              >
                <ChevronLeft />
              </button>
              <span aria-live="polite">
                {detailIndex + 1} of {filtered.length}
              </span>
              <button
                className="icon-button"
                aria-label="Next photo"
                disabled={detailIndex >= filtered.length - 1}
                onClick={() => move(1)}
              >
                <ChevronRight />
              </button>
            </div>
            <div className="dialog-footer">
              {detail.expiresAt && (
                <span className="photo-expiry">
                  Available until {new Date(detail.expiresAt).toLocaleString()}
                </span>
              )}
              <span>
                {detail.width} x {detail.height}
                {detail.bytes
                  ? ` / ${(detail.bytes / 1024 / 1024).toFixed(2)} MB`
                  : ''}
              </span>
              <button
                className="button secondary compact"
                aria-pressed={selected.has(detail.id)}
                onClick={() => toggle(detail.id)}
              >
                <Check size={17} />
                {selected.has(detail.id) ? 'Selected' : 'Select photo'}
              </button>
              <a
                className="button compact"
                href={`${fileUrl(detail.id, eventId)}?download=1`}
                aria-disabled={busy}
                onClick={(event) => {
                  event.preventDefault();
                  void download([detail], false);
                }}
                download
              >
                <ArrowDownToLine size={17} />
                Download
              </a>
              {!readOnly && (
                <button
                  className="icon-button danger"
                  aria-label="Delete photo"
                  disabled={deleting || busy}
                  onClick={() => void remove()}
                >
                  <Trash2 size={17} />
                </button>
              )}
            </div>
            <ErrorNote error={error} />
          </>
        )}
      </dialog>
    </div>
  );
}
