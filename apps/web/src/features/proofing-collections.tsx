import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, fileUrl, HttpError, type Photo } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import {
  PROOFING_COLLECTION_PHOTO_LIMIT,
  type ProofingCollection,
} from '../../../../packages/shared/src/proofing-collection';
import './proofing-collections.css';

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
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
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
      if (editing?.id === collection.id) setEditing(null);
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
        Collections do not change guest requests or grant gallery access.
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
          key={editing?.id ?? 'new'}
          root={root}
          photos={photos}
          initial={editing}
          onCancel={() => {
            setEditing(null);
            setCreating(false);
          }}
          onSaved={() => {
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
}: {
  root: string;
  photos: Photo[];
  initial: ProofingCollection | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const client = useQueryClient();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [ids, setIds] = useState(initial?.photoIds ?? []);
  const [version, setVersion] = useState(initial?.version ?? 1);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const available = new Set(photos.map((photo) => photo.id));
  const unavailable = ids.filter((id) => !available.has(id));
  const candidates = photos.filter((photo) =>
    photo.filename.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || conflict) return;
    setBusy(true);
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
    }
  }
  async function reload() {
    if (!initial || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ collection: ProofingCollection }>(
        `${root}/${initial.id}`,
      );
      setTitle(result.collection.title);
      setIds(result.collection.photoIds);
      setVersion(result.collection.version);
      setConflict(false);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
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
          onChange={(event) => setSearch(event.target.value)}
        />
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
        {candidates.slice(0, 100).map((photo) => (
          <label key={photo.id} className="proofing-photo-choice">
            <input
              type="checkbox"
              checked={ids.includes(photo.id)}
              disabled={
                !ids.includes(photo.id) &&
                ids.length >= PROOFING_COLLECTION_PHOTO_LIMIT
              }
              onChange={() =>
                setIds(
                  ids.includes(photo.id)
                    ? ids.filter((id) => id !== photo.id)
                    : [...ids, photo.id],
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
            <span>{photo.filename}</span>
          </label>
        ))}
      </fieldset>
      {candidates.length > 100 && (
        <p>
          Showing the first 100 matches. Refine the filename filter to find
          other photos.
        </p>
      )}
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
