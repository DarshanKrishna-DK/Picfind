import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, HttpError, session, type Library } from '../api';
import { ErrorNote, Loading, errorMessage } from '../components/ui';
import {
  FOLDER_ACTOR_HEADER,
  FOLDER_GROUP_LIMIT,
  inspectFolder,
  type FolderFile,
  type FolderMapping,
} from '../../../../packages/shared/src/folder-import';
import {
  parseUploadQueue,
  uploadQueueKey,
} from '../../../../packages/shared/src/upload-queue';
import {
  UploadQueueBusy,
  UploadQueueController,
  UploadQueueFailure,
  type UploadQueueView,
} from './upload-queue-controller';
import './folder-import.css';

export function FolderImport({ eventId }: { eventId?: string }) {
  const account = useQuery({
    queryKey: ['session'],
    queryFn: session,
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  if (account.isPending) return <Loading />;
  if (!account.data || account.error)
    return (
      <ErrorNote
        error={account.error ?? new Error('Sign in to import a folder.')}
      />
    );
  return (
    <FolderPanel
      key={`${account.data.id}:${eventId ?? 'personal'}`}
      accountId={account.data.id}
      eventId={eventId ?? null}
    />
  );
}

function FolderPanel({
  accountId,
  eventId,
}: {
  accountId: string;
  eventId: string | null;
}) {
  const library = useQuery({
    queryKey: ['folder-import-library', accountId, eventId],
    queryFn: ({ signal }) => api<Library>('/library', { signal }),
    refetchOnWindowFocus: 'always',
    retry: false,
  });
  const event = library.data?.events.find((row) => row.id === eventId);
  const available = Boolean(
    library.data &&
    !library.error &&
    (!eventId ||
      (event &&
        event.accessRole !== 'moderator' &&
        !event.archived &&
        (!event.expiresAt || Date.parse(event.expiresAt) > Date.now()))),
  );
  const [view, setView] = useState<UploadQueueView>({
    queue: null,
    operation: null,
    attached: 0,
    externalBusy: false,
  });
  const [report, setReport] = useState<FolderFile[]>([]);
  const [choices, setChoices] = useState<
    (FolderMapping & { include: boolean })[]
  >([]);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [mapping, setMapping] = useState(false);
  const [results, setResults] = useState<Record<string, string>>({});
  const [denied, setDenied] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const instance = useRef<UploadQueueController | null>(null);
  const mounted = useRef(false);
  const pending = useRef<AbortController | null>(null);
  const client = useQueryClient();
  useEffect(() => {
    mounted.current = true;
    let queue: UploadQueueController | undefined;
    const changed = () => {
      if (!queue?.view.operation) void refresh();
    };
    async function refresh() {
      try {
        await queue?.refresh();
      } catch (failure) {
        if (mounted.current) setError(failure);
      }
    }
    try {
      if (!navigator.locks || !crypto.subtle)
        throw new Error(
          'Folder imports need browser locks and secure hashing. Use quick upload in this browser.',
        );
      const key = uploadQueueKey(accountId, eventId, true);
      queue = new UploadQueueController({
        accountId,
        eventId,
        folder: true,
        storage: localStorage,
        exclusive: async (work) =>
          navigator.locks.request(key, { ifAvailable: true }, async (lock) => {
            if (!lock) throw new UploadQueueBusy();
            await work();
          }),
        digest: async (file) =>
          [
            ...new Uint8Array(
              await crypto.subtle.digest('SHA-256', await file.arrayBuffer()),
            ),
          ]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join(''),
        upload: async (file, item, signal) => {
          try {
            const response = await api<{
              photo: { id: string; eventId?: string };
            }>(
              `/photos${eventId ? `?eventId=${encodeURIComponent(eventId)}` : ''}`,
              {
                method: 'POST',
                signal,
                body: file,
                headers: {
                  'Content-Type': 'application/octet-stream',
                  'X-File-Name': encodeURIComponent(item.name),
                  [FOLDER_ACTOR_HEADER]: accountId,
                },
              },
            );
            if (!response.photo || (response.photo.eventId ?? null) !== eventId)
              throw new UploadQueueFailure(
                'The upload reply belongs to another destination. Refresh before resuming.',
                true,
              );
            return response.photo.id;
          } catch (failure) {
            if (failure instanceof HttpError) {
              if (
                [401, 403].includes(failure.status) ||
                (failure.status === 409 &&
                  /account/i.test(errorMessage(failure)))
              ) {
                if (mounted.current) setDenied(true);
              }
              throw new UploadQueueFailure(
                errorMessage(failure),
                [401, 403, 404, 409, 410, 413].includes(failure.status),
              );
            }
            throw failure;
          }
        },
        changed: (next) => {
          if (mounted.current) setView(next);
        },
      });
      instance.current = queue;
      // A remounted panel must not contend with its disposed startup instance.
      void Promise.resolve().then(() => {
        if (mounted.current && instance.current === queue) return refresh();
      });
    } catch (failure) {
      setError(failure);
    }
    const pause = () => {
      queue?.pause();
      pending.current?.abort();
    };
    window.addEventListener('storage', changed);
    window.addEventListener('pagehide', pause);
    return () => {
      mounted.current = false;
      queue?.dispose();
      pending.current?.abort();
      instance.current = null;
      window.removeEventListener('storage', changed);
      window.removeEventListener('pagehide', pause);
    };
  }, [accountId, eventId]);

  const queue = view.queue;
  const busy = Boolean(view.operation) || mapping;
  const selectedFolders = choices.filter((row) => row.include);
  const selectedFiles = report.filter(
    (row) =>
      !row.reason &&
      selectedFolders.some((folder) => folder.path === row.folder),
  );
  const validPlan =
    selectedFolders.length > 0 &&
    selectedFolders.length <= FOLDER_GROUP_LIMIT &&
    selectedFiles.length > 0 &&
    selectedFiles.length <= 100 &&
    selectedFolders.every((row) => row.title.trim().length > 0);
  const completed =
    queue?.items.filter((row) => row.status === 'complete').length ?? 0;

  async function choose(files: File[]) {
    setError(null);
    setMessage('');
    try {
      const rows = inspectFolder(files);
      if (queue) {
        const supported = rows
          .filter((row) => !row.reason)
          .map((row) => row.file);
        if (supported.length > 100)
          throw new Error(
            'Reselect a folder with at most 100 supported files, or select a smaller subfolder for recovery.',
          );
        await instance.current?.prepare(supported);
        if (mounted.current)
          setMessage(
            'Matching originals attached. Review saved progress before resuming.',
          );
        return;
      }
      setReport(rows);
      setChoices(
        [
          ...new Set(
            rows.filter((row) => !row.reason).map((row) => row.folder),
          ),
        ].map((path) => ({
          path,
          title: path.split('/').at(-1)!.slice(0, 100),
          collectionId: crypto.randomUUID(),
          createCollection: false,
          include: true,
        })),
      );
      setMessage('Folder inspected. No image bytes were uploaded.');
    } catch (failure) {
      if (mounted.current) {
        setError(failure);
        if (!queue) {
          setReport([]);
          setChoices([]);
        }
      }
    } finally {
      if (input.current) input.current.value = '';
    }
  }
  async function action(
    kind: 'prepare' | 'run' | 'refresh' | 'cancel' | 'clear',
  ) {
    const active = instance.current;
    if (!active || busy) return;
    setError(null);
    setMessage('');
    try {
      if (kind === 'prepare') {
        if (!validPlan)
          throw new Error(
            'Choose 1 to 100 supported files across at most 20 named folders.',
          );
        await active.prepare(
          selectedFiles.map((row) => row.file),
          selectedFolders.map(({ include, ...row }) => {
            void include;
            return row;
          }),
        );
        if (mounted.current && active.view.queue) {
          setReport([]);
          setChoices([]);
        }
      } else await active[kind]();
      if (!mounted.current) return;
      if (kind === 'clear') setResults({});
      if (kind === 'run') {
        await client.invalidateQueries({ queryKey: ['library'] });
        await library.refetch();
        await client.invalidateQueries({
          queryKey: ['event-gallery', eventId],
        });
      }
      if (mounted.current)
        setMessage(
          kind === 'clear'
            ? 'Saved folder plan cleared. Server photos and collections were kept.'
            : active.view.queue?.mode === 'complete'
              ? 'Folder uploads completed. Review collection mappings below.'
              : 'Folder progress saved. No further uploads start until you choose to resume.',
        );
    } catch (failure) {
      if (mounted.current) setError(failure);
    }
  }
  function change(
    path: string,
    changes: Partial<FolderMapping & { include: boolean }>,
  ) {
    setChoices((previous) =>
      previous.map((row) => (row.path === path ? { ...row, ...changes } : row)),
    );
  }
  async function createCollections() {
    if (!queue || queue.mode !== 'complete' || !eventId || busy) return;
    const controller = new AbortController();
    pending.current = controller;
    setMapping(true);
    setError(null);
    try {
      await navigator.locks.request(
        uploadQueueKey(accountId, eventId, true),
        { ifAvailable: true },
        async (lock) => {
          if (!lock) throw new UploadQueueBusy();
          const unchanged = () => {
            const latest = parseUploadQueue(
              localStorage.getItem(uploadQueueKey(accountId, eventId, true)),
              accountId,
              eventId,
            );
            if (JSON.stringify(latest) !== JSON.stringify(queue))
              throw new Error(
                'The saved folder plan changed. Refresh its progress before creating collections.',
              );
          };
          for (const folder of queue.folders?.filter(
            (row) => row.createCollection,
          ) ?? []) {
            if (controller.signal.aborted) break;
            unchanged();
            const ids = [
              ...new Set(
                queue.items
                  .filter((item) =>
                    item.relativePaths?.some(
                      (path) =>
                        path.slice(0, path.lastIndexOf('/')) === folder.path,
                    ),
                  )
                  .map((item) => item.photoId!),
              ),
            ];
            const response = await api<{
              collection: { id: string; title: string; photoIds: string[] };
            }>(
              `/events/${eventId}/proofing-collections/${folder.collectionId}/import`,
              {
                method: 'PUT',
                signal: controller.signal,
                headers: { [FOLDER_ACTOR_HEADER]: accountId },
                body: JSON.stringify({ title: folder.title, photoIds: ids }),
              },
            );
            if (controller.signal.aborted || !mounted.current) break;
            if (
              response.collection?.id !== folder.collectionId ||
              response.collection.title !== folder.title.trim() ||
              JSON.stringify([...response.collection.photoIds].sort()) !==
                JSON.stringify([...ids].sort())
            )
              throw new Error(
                'The collection reply did not match this folder. Retry to recover its result.',
              );
            setResults((previous) => ({
              ...previous,
              [folder.path]: 'Collection confirmed',
            }));
          }
        },
      );
      if (mounted.current && !controller.signal.aborted) {
        await client.invalidateQueries({
          queryKey: ['proofing-collections', eventId],
        });
        setMessage(
          'Folder collections confirmed. They remain private until separately invited or published.',
        );
      }
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) {
        if (
          failure instanceof HttpError &&
          ([401, 403].includes(failure.status) ||
            (failure.status === 409 && /account/i.test(errorMessage(failure))))
        )
          setDenied(true);
        setError(failure);
        setMessage(
          'Collection mapping stopped. Confirmed collections remain. Retry checks the same collection identities.',
        );
      }
    } finally {
      if (pending.current === controller) pending.current = null;
      if (mounted.current) setMapping(false);
    }
  }

  if (denied)
    return (
      <section className="source-panel">
        <h2>Folder import paused</h2>
        <p>
          The signed-in account changed or access was denied. Reload before
          continuing.
        </p>
      </section>
    );
  return (
    <section
      className="source-panel folder-import"
      aria-label="Folder import plan"
    >
      <h2>Plan a folder import</h2>
      <p>
        Review nested folders before uploading. JPEG, PNG and WebP images up to
        8 MiB each. Download permitted cloud collections and extract ZIP files
        on your device first.
      </p>
      <p>
        Destination:{' '}
        <strong>
          {eventId
            ? (event?.title ?? 'Event unavailable')
            : 'Your personal library'}
        </strong>
      </p>
      {!available && (
        <p>
          This destination is unavailable. Saved progress remains, but new
          uploads and mappings are disabled.
        </p>
      )}
      <ErrorNote error={error ?? library.error} />
      <p role="status">{message}</p>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label="Select folder for import"
        disabled={busy || !available || view.externalBusy}
        onChange={(e) => void choose(Array.from(e.target.files ?? []))}
      />
      <div className="toolbar">
        <button
          className="button secondary"
          type="button"
          disabled={
            busy || !available || view.externalBusy || !instance.current
          }
          onClick={() => {
            input.current?.setAttribute('webkitdirectory', '');
            input.current?.click();
          }}
        >
          {queue ? 'Reselect folder originals' : 'Choose a folder'}
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={busy || !instance.current}
          onClick={() => void action('refresh')}
        >
          Refresh folder progress
        </button>
      </div>
      {view.externalBusy && (
        <p>
          Another tab is using this folder queue. Refresh after it finishes or
          pauses.
        </p>
      )}
      {!!report.length && !queue && (
        <>
          <p>
            {report.length} files inspected.{' '}
            {report.filter((row) => row.reason).length} excluded.{' '}
            {selectedFiles.length} supported files selected,{' '}
            {selectedFiles
              .reduce((sum, row) => sum + row.file.size, 0)
              .toLocaleString()}{' '}
            original bytes.
          </p>
          <p>
            Choose at most 100 files across 20 folders. Estimates use original
            sizes; server capacity and image validation still apply.
          </p>
          <div className="folder-plan-groups">
            {choices.map((folder) => (
              <fieldset key={folder.path}>
                <legend>{folder.path}</legend>
                <label>
                  <input
                    type="checkbox"
                    checked={folder.include}
                    disabled={busy}
                    onChange={(e) =>
                      change(folder.path, { include: e.target.checked })
                    }
                  />
                  Include folder
                </label>
                <p>
                  {
                    report.filter(
                      (row) => !row.reason && row.folder === folder.path,
                    ).length
                  }{' '}
                  supported files
                </p>
                {eventId && (
                  <>
                    <label>
                      <input
                        type="checkbox"
                        checked={folder.createCollection}
                        disabled={busy || !folder.include}
                        onChange={(e) =>
                          change(folder.path, {
                            createCollection: e.target.checked,
                          })
                        }
                      />
                      Create a private proofing collection
                    </label>
                    <label>
                      Collection title
                      <input
                        value={folder.title}
                        maxLength={100}
                        disabled={busy || !folder.include}
                        onChange={(e) =>
                          change(folder.path, { title: e.target.value })
                        }
                      />
                    </label>
                  </>
                )}
              </fieldset>
            ))}
          </div>
          <details>
            <summary>Inspect file report</summary>
            <ul className="folder-file-report">
              {report.map((row) => (
                <li key={row.path}>
                  <strong>{row.path}</strong>: {row.reason ?? 'Supported'} (
                  {row.file.size.toLocaleString()} bytes)
                </li>
              ))}
            </ul>
          </details>
          <button
            className="button"
            type="button"
            disabled={busy || !available || !validPlan || view.externalBusy}
            onClick={() => void action('prepare')}
          >
            Save reviewed folder plan
          </button>
        </>
      )}
      {view.operation === 'prepare' && (
        <>
          <p role="status">
            Fingerprinting one image at a time. No uploads have started.
          </p>
          <button
            className="button secondary"
            type="button"
            onClick={() => instance.current?.pause()}
          >
            Stop preparing folder
          </button>
        </>
      )}
      {queue && (
        <>
          <p>
            {completed} of {queue.items.length} uploads acknowledged. Queue:{' '}
            {queue.mode}.
          </p>
          <p>
            This browser stores relative paths, filenames, fingerprints,
            mappings and progress for this account. Original image bytes are not
            saved. Reselect originals after reload. Identical bytes share one
            upload and retain each source path.
          </p>
          <p>
            {view.attached} unfinished originals attached. Stored
            acknowledgements do not prove that a server photo is still retained.
          </p>
          <ul className="folder-file-report">
            {queue.items.map((item) => (
              <li key={item.id}>
                <strong>{item.relativePaths?.join(' | ') ?? item.name}</strong>:{' '}
                {item.status}
                {item.error && <span role="alert">. {item.error}</span>}
              </li>
            ))}
          </ul>
          <div className="toolbar">
            <button
              className="button"
              type="button"
              disabled={
                busy || !available || !view.attached || view.externalBusy
              }
              onClick={() => void action('run')}
            >
              Start or resume folder upload
            </button>
            {view.operation === 'run' && (
              <button
                className="button secondary"
                type="button"
                onClick={() => instance.current?.pause()}
              >
                Pause folder upload
              </button>
            )}
            <button
              className="button secondary"
              type="button"
              disabled={busy || queue.mode === 'complete'}
              onClick={() => void action('cancel')}
            >
              Cancel unfinished folder uploads
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    'Clear this browser folder plan? Server photos and collections will be kept.',
                  )
                )
                  void action('clear');
              }}
            >
              Clear saved folder plan
            </button>
          </div>
          {queue.folders?.some((folder) => folder.createCollection) && (
            <div>
              <h3>Reviewed collection mappings</h3>
              <ul>
                {queue.folders
                  .filter((folder) => folder.createCollection)
                  .map((folder) => (
                    <li key={folder.path}>
                      {folder.path} → {folder.title}.{' '}
                      {
                        queue.items.filter((item) =>
                          item.relativePaths?.some(
                            (path) =>
                              path.slice(0, path.lastIndexOf('/')) ===
                              folder.path,
                          ),
                        ).length
                      }{' '}
                      photos. {results[folder.path] ?? 'Awaiting confirmation'}
                    </li>
                  ))}
              </ul>
              <p>
                After all uploads finish, create these exact private
                collections. This does not send invitations or publish photos.
              </p>
              <button
                className="button secondary"
                type="button"
                disabled={busy || !available || queue.mode !== 'complete'}
                onClick={() => void createCollections()}
              >
                Create or verify folder collections
              </button>
              {mapping && (
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => {
                    pending.current?.abort();
                    setMessage(
                      'Mapping stopped. A pending collection may have been saved. Retry checks its original identity.',
                    );
                  }}
                >
                  Stop mapping
                </button>
              )}
              {eventId && (
                <p>
                  <Link to={`/app/events/${eventId}`}>
                    Manage event collections
                  </Link>
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
