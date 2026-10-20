import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, fileUrl, HttpError, type Photo } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import {
  PROOFING_COLLECTION_PHOTO_LIMIT,
  type ProofingCollection,
} from '../../../../packages/shared/src/proofing-collection';
import './proofing-collections.css';
import { CollectionInvitations } from './collection-invitations';

export function ProofingCollections({
  eventId,
  photos,
}: {
  eventId: string;
  photos: Photo[];
}) {
  const root = `/events/${eventId}/proofing-collections`;
  const query = useQuery({
    queryKey: ['proofing-collections', eventId],
    queryFn: ({ signal }) =>
      api<{ collections: ProofingCollection[]; limit: number }>(root, {
        signal,
      }),
    retry: false,
  });
  const [editing, setEditing] = useState<ProofingCollection | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [editorRevision, setEditorRevision] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  function discardDraft() {
    if (
      busy ||
      (dirty && !window.confirm('Discard unsaved collection changes?'))
    )
      return false;
    setDirty(false);
    return true;
  }
  async function remove(collection: ProofingCollection) {
    if (
      busy ||
      !window.confirm(
        'Delete this collection? Photos and guest requests are kept.',
      )
    )
      return;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      await api(`${root}/${collection.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ version: collection.version }),
      });
      if (editing?.id === collection.id) {
        setEditing(null);
        setDirty(false);
      }
      setMessage(
        'Collection deleted. Photos and guest requests are unchanged.',
      );
      void query.refetch();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="source-panel" aria-label="Proofing collections">
      <h2>Named proofing collections</h2>
      <p>
        Keep private photo sets for album planning and retouching rounds.
        Collections do not change guest requests. Use client invitations to
        grant access to a specific account.
      </p>
      <div className="actions">
        <button
          className="button"
          disabled={
            busy ||
            !query.data ||
            query.data.collections.length >= query.data.limit
          }
          onClick={() => {
            if (!discardDraft()) return;
            setEditorRevision((current) => current + 1);
            setEditing(null);
            setCreating(true);
            setMessage('');
          }}
        >
          New collection
        </button>
        <button
          className="button secondary"
          disabled={query.isFetching || busy}
          onClick={() => void query.refetch()}
        >
          Refresh collections
        </button>
      </div>
      {query.data && (
        <p>
          {query.data.collections.length} / {query.data.limit} collections
        </p>
      )}
      <ErrorNote error={query.error ?? error} />
      <p role="status">{message}</p>
      {(creating || editing) && (
        <CollectionEditor
          key={`${editing?.id ?? 'new'}:${editorRevision}`}
          root={root}
          photos={photos}
          initial={editing}
          onBusyChange={setBusy}
          onDirtyChange={setDirty}
          onCancel={() => {
            if (!discardDraft()) return;
            setEditing(null);
            setCreating(false);
          }}
          onSaved={() => {
            setDirty(false);
            setEditing(null);
            setCreating(false);
            setMessage('Collection saved.');
            void query.refetch();
          }}
        />
      )}
      {query.isPending ? (
        <Loading />
      ) : (
        !query.error &&
        query.data && (
          <ul className="selection-list">
            {query.data.collections.map((collection) => (
              <li className="selection-card" key={collection.id}>
                <h3>{collection.title}</h3>
                <p>{collection.photoIds.length} selected photos</p>
                {collection.unavailableCount > 0 && (
                  <p>{collection.unavailableCount} photos are unavailable.</p>
                )}
                <ul aria-label={`${collection.title} filenames`}>
                  {collection.photos.map((photo) => (
                    <li key={photo.id}>{photo.filename}</li>
                  ))}
                </ul>
                <div className="actions">
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => {
                      if (!discardDraft()) return;
                      setEditorRevision((current) => current + 1);
                      setCreating(false);
                      setEditing(collection);
                      setMessage('');
                    }}
                  >
                    Edit {collection.title}
                  </button>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void remove(collection)}
                  >
                    Delete {collection.title}
                  </button>
                </div>
                <CollectionInvitations
                  eventId={eventId}
                  collectionId={collection.id}
                  title={collection.title}
                />
              </li>
            ))}
          </ul>
        )
      )}
      {query.data?.collections.length === 0 && (
        <p>No collections yet. Create your first photo set.</p>
      )}
    </section>
  );
}

function CollectionEditor({
  root,
  photos,
  initial,
  onCancel,
  onSaved,
  onBusyChange,
  onDirtyChange,
}: {
  root: string;
  photos: Photo[];
  initial: ProofingCollection | null;
  onCancel: () => void;
  onSaved: () => void;
  onBusyChange: (busy: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const client = useQueryClient();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [ids, setIds] = useState(initial?.photoIds ?? []);
  const [version, setVersion] = useState(initial?.version ?? 1);
  const [search, setSearch] = useState('');
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [baseline, setBaseline] = useState({
    title: initial?.title ?? '',
    photoIds: initial?.photoIds ?? [],
  });
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const dirty =
    title !== baseline.title ||
    ids.length !== baseline.photoIds.length ||
    ids.some((id) => !baseline.photoIds.includes(id));
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const available = new Set(photos.map((photo) => photo.id));
  const unavailable = ids.filter((id) => !available.has(id));
  const candidates = photos.filter(
    (photo) =>
      (!selectedOnly || ids.includes(photo.id)) &&
      (photo.filename ?? 'photo.jpg')
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(candidates.length / 100));
  const currentPage = Math.min(page, pages - 1);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || conflict) return;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      await api(initial ? `${root}/${initial.id}` : root, {
        method: initial ? 'PATCH' : 'POST',
        body: JSON.stringify({
          title,
          photoIds: ids,
          ...(initial ? { version } : {}),
        }),
      });
      onSaved();
    } catch (failure) {
      setError(failure);
      if (failure instanceof HttpError && failure.code === 'COLLECTION_CHANGED')
        setConflict(true);
      if (
        failure instanceof HttpError &&
        failure.code === 'COLLECTION_PHOTOS_UNAVAILABLE'
      )
        void client.invalidateQueries({ queryKey: ['library'] });
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }
  async function reload() {
    if (!initial || busy) return;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      const result = await api<{ collection: ProofingCollection }>(
        `${root}/${initial.id}`,
      );
      setTitle(result.collection.title);
      setIds(result.collection.photoIds);
      setVersion(result.collection.version);
      setBaseline({
        title: result.collection.title,
        photoIds: result.collection.photoIds,
      });
      setConflict(false);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }
  return (
    <form
      className="selection-card"
      aria-label="Collection editor"
      onSubmit={(event) => void save(event)}
    >
      <h3>{initial ? 'Edit collection' : 'Create collection'}</h3>
      <label>
        Collection name
        <input
          value={title}
          maxLength={100}
          required
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label>
        Filter collection photos
        <input
          type="search"
          value={search}
          disabled={busy}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(0);
          }}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={selectedOnly}
          disabled={busy}
          onChange={(event) => {
            setSelectedOnly(event.target.checked);
            setPage(0);
          }}
        />
        Show selected photos only
      </label>
      <p>
        {ids.length} / {PROOFING_COLLECTION_PHOTO_LIMIT} photos selected
      </p>
      {unavailable.length > 0 && (
        <p>
          {unavailable.length} saved photos are unavailable.{' '}
          <button
            type="button"
            className="text-link"
            disabled={busy}
            onClick={() => setIds(ids.filter((id) => available.has(id)))}
          >
            Remove unavailable photos from this collection
          </button>
        </p>
      )}
      <fieldset disabled={busy} className="proofing-photo-options">
        <legend>Photos for this collection</legend>
        {candidates
          .slice(currentPage * 100, (currentPage + 1) * 100)
          .map((photo) => (
            <label key={photo.id} className="proofing-photo-choice">
              <input
                type="checkbox"
                checked={ids.includes(photo.id)}
                disabled={
                  !ids.includes(photo.id) &&
                  ids.length >= PROOFING_COLLECTION_PHOTO_LIMIT
                }
                onChange={() =>
                  setIds((current) =>
                    current.includes(photo.id)
                      ? current.filter((id) => id !== photo.id)
                      : current.length >= PROOFING_COLLECTION_PHOTO_LIMIT
                        ? current
                        : [...current, photo.id],
                  )
                }
              />
              <img
                src={fileUrl(photo.id)}
                alt=""
                loading="lazy"
                width={80}
                height={60}
              />
              <span>{photo.filename ?? 'photo.jpg'}</span>
            </label>
          ))}
      </fieldset>
      <div className="actions" aria-label="Photo pages">
        <button
          type="button"
          className="button secondary"
          disabled={busy || currentPage === 0}
          onClick={() => setPage(currentPage - 1)}
        >
          Previous photo page
        </button>
        <span>
          Photo page {currentPage + 1} of {pages}
        </span>
        <button
          type="button"
          className="button secondary"
          disabled={busy || currentPage + 1 >= pages}
          onClick={() => setPage(currentPage + 1)}
        >
          Next photo page
        </button>
      </div>
      <div className="actions">
        <button
          className="button"
          disabled={
            busy ||
            conflict ||
            !title.trim() ||
            !ids.length ||
            unavailable.length > 0
          }
        >
          Save collection
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel collection editing
        </button>
        {conflict && (
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => void reload()}
          >
            Replace draft with latest collection
          </button>
        )}
      </div>
      <ErrorNote error={error} />
    </form>
  );
}
