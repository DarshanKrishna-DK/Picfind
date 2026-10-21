import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, HttpError, session } from '../api';
import { ErrorNote, Loading, errorMessage } from '../components/ui';
import { UploadPreflight } from './upload-preflight';
import {
  UPLOAD_QUEUE_LIMIT,
  uploadQueueKey,
} from '../../../../packages/shared/src/upload-queue';
import {
  UploadQueueController,
  UploadQueueBusy,
  UploadQueueFailure,
  type UploadQueueView,
} from './upload-queue-controller';

export function SavedUploadQueue({
  eventId,
  available,
  onBusy,
}: {
  eventId: string | undefined;
  available: boolean;
  onBusy: (value: boolean) => void;
}) {
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
        error={
          account.error ?? new Error('Sign in to use a saved upload queue.')
        }
      />
    );
  return (
    <QueuePanel
      key={`${account.data.id}:${eventId ?? 'personal'}`}
      accountId={account.data.id}
      eventId={eventId ?? null}
      available={available}
      onBusy={onBusy}
    />
  );
}

function QueuePanel({
  accountId,
  eventId,
  available,
  onBusy,
}: {
  accountId: string;
  eventId: string | null;
  available: boolean;
  onBusy: (value: boolean) => void;
}) {
  const [view, setView] = useState<UploadQueueView>({
    queue: null,
    operation: null,
    attached: 0,
    externalBusy: false,
  });
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const controller = useRef<UploadQueueController | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const client = useQueryClient();
  useEffect(() => {
    mounted.current = true;
    let instance: UploadQueueController;
    try {
      if (!navigator.locks || !crypto.subtle)
        throw new Error(
          'Saved queues need browser locks and secure hashing. Quick upload remains available in this browser.',
        );
      const key = uploadQueueKey(accountId, eventId);
      instance = new UploadQueueController({
        accountId,
        eventId,
        storage: window.localStorage,
        exclusive: async (work) => {
          await navigator.locks.request(
            key,
            { ifAvailable: true },
            async (lock) => {
              if (!lock) throw new UploadQueueBusy();
              await work();
            },
          );
        },
        digest: async (file) => {
          const hash = await crypto.subtle.digest(
            'SHA-256',
            await file.arrayBuffer(),
          );
          return [...new Uint8Array(hash)]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('');
        },
        upload: async (file, item, signal) => {
          try {
            const response = await api<{
              photo: { id: string; eventId?: string };
            }>(
              '/photos' +
                (eventId ? `?eventId=${encodeURIComponent(eventId)}` : ''),
              {
                method: 'POST',
                signal,
                body: file,
                headers: {
                  'Content-Type': 'application/octet-stream',
                  'X-File-Name': encodeURIComponent(item.name),
                  'X-PicFind-Upload-Actor': accountId,
                },
              },
            );
            if (!response.photo || (response.photo.eventId ?? null) !== eventId)
              throw new UploadQueueFailure(
                'The upload acknowledgement belongs to another destination. Refresh before resuming.',
                true,
              );
            return response.photo.id;
          } catch (failure) {
            if (failure instanceof HttpError)
              throw new UploadQueueFailure(
                errorMessage(failure),
                [401, 403, 404, 409, 410, 413].includes(failure.status),
              );
            throw failure;
          }
        },
        changed: (next) => {
          if (mounted.current) {
            setView(next);
            onBusy(Boolean(next.operation));
          }
        },
      });
      controller.current = instance;
    } catch (failure) {
      setError(failure);
      onBusy(false);
      return () => {
        mounted.current = false;
      };
    }
    async function refresh() {
      try {
        await instance.refresh();
        if (mounted.current && controller.current === instance) setError(null);
      } catch (failure) {
        if (mounted.current && controller.current === instance)
          setError(failure);
      }
    }
    function storage(event: StorageEvent) {
      if (
        (event.key === instance.key || event.key === null) &&
        !instance.view.operation
      )
        void refresh();
    }
    const pause = () => instance.pause();
    window.addEventListener('storage', storage);
    window.addEventListener('pagehide', pause);
    // A remounted panel must not contend with its disposed startup instance.
    void Promise.resolve().then(() => {
      if (mounted.current && controller.current === instance) return refresh();
    });
    return () => {
      mounted.current = false;
      instance.dispose();
      onBusy(false);
      if (controller.current === instance) controller.current = null;
      window.removeEventListener('storage', storage);
      window.removeEventListener('pagehide', pause);
    };
  }, [accountId, eventId, client, onBusy]);

  async function action(
    kind: 'prepare' | 'run' | 'clear' | 'refresh' | 'cancel',
    files?: File[],
  ) {
    const instance = controller.current;
    if (!instance) return;
    setError(null);
    setMessage('');
    try {
      if (kind === 'prepare') await instance.prepare(files ?? []);
      else await instance[kind]();
      if (!mounted.current) return;
      if (kind === 'run') {
        await client.invalidateQueries({ queryKey: ['library'] });
        await client.invalidateQueries({
          queryKey: ['event-gallery', eventId],
        });
      }
      if (!mounted.current) return;
      setMessage(
        kind === 'clear'
          ? 'Saved queue cleared. Server photos were kept.'
          : kind === 'prepare'
            ? `${instance.view.attached} unfinished files matched and ready.`
            : instance.view.queue?.mode === 'complete'
              ? 'Batch completed.'
              : instance.view.queue?.mode === 'cancelled'
                ? 'Unfinished uploads cancelled. Server photos were kept.'
                : 'Progress saved. Resume when the required originals are selected.',
      );
    } catch (failure) {
      if (mounted.current) setError(failure);
    } finally {
      if (picker.current) picker.current.value = '';
    }
  }
  const queue = view.queue;
  const busy = Boolean(view.operation);
  const completed =
    queue?.items.filter((item) => item.status === 'complete').length ?? 0;
  const unfinished = (queue?.items.length ?? 0) - completed;
  return (
    <section className="stack" aria-label="Saved upload queue">
      <h3>Recoverable upload batch</h3>
      <p>
        This browser saves filenames, sizes, content fingerprints and progress
        for this account and destination. Original image bytes are not saved.
        After a reload, reselect originals to resume.
      </p>
      <p>
        Up to {UPLOAD_QUEUE_LIMIT} JPEG, PNG or WebP files, 8 MiB each.
        Identical selected files share one queue item. Renamed originals match
        by content and keep the saved upload filename.
      </p>
      {!available && (
        <p>
          This destination is unavailable. Saved progress remains here, but
          uploads are disabled.
        </p>
      )}
      <ErrorNote error={error} />
      <p role="status">{message}</p>
      {view.externalBusy && (
        <p>
          Another tab holds this queue. Refresh after it pauses or finishes.
        </p>
      )}
      {busy && (
        <p role="status">
          {view.operation === 'prepare'
            ? 'Reading file fingerprints…'
            : view.operation === 'run'
              ? 'Uploading one file at a time…'
              : 'Updating saved progress…'}
        </p>
      )}
      <input
        ref={picker}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp"
        className="visually-hidden"
        aria-label={queue ? 'Reselect batch originals' : 'Choose batch photos'}
        disabled={
          busy || view.externalBusy || !available || !controller.current
        }
        onChange={(event) =>
          void action('prepare', Array.from(event.target.files ?? []))
        }
      />
      <div className="toolbar">
        <button
          className="button secondary"
          disabled={
            busy || view.externalBusy || !available || !controller.current
          }
          onClick={() => picker.current?.click()}
        >
          {queue ? 'Reselect originals' : 'Choose batch photos'}
        </button>
        <button
          className="button"
          disabled={busy || view.externalBusy || !available || !view.attached}
          onClick={() => void action('run')}
        >
          Start or resume batch
        </button>
        {view.operation === 'run' && (
          <button
            className="button secondary"
            onClick={() => {
              controller.current?.pause();
              setMessage(
                'Stopping the current request. Its result may need recovery.',
              );
            }}
          >
            Pause uploads
          </button>
        )}
        {view.operation === 'prepare' && (
          <button
            className="button secondary"
            onClick={() => controller.current?.pause()}
          >
            Stop preparing
          </button>
        )}
        {unfinished > 0 && (
          <button
            className="button secondary"
            disabled={busy && view.operation !== 'run'}
            onClick={() => {
              if (view.operation === 'run') {
                void controller.current?.cancel();
                setMessage('Stopping unfinished uploads.');
              } else void action('cancel');
            }}
          >
            Cancel unfinished uploads
          </button>
        )}
        <button
          className="button secondary"
          disabled={busy || !controller.current}
          onClick={() => void action('refresh')}
        >
          Refresh saved queue
        </button>
        <button
          className="button secondary"
          disabled={busy || !controller.current}
          onClick={() => void action('clear')}
        >
          Clear saved queue
        </button>
      </div>
      {queue && (
        <>
          <UploadPreflight
            queue={queue}
            disabled={busy || view.externalBusy || !available}
          />
          <p>
            {completed} of {queue.items.length} uploads acknowledged. Queue:{' '}
            {queue.mode}.
          </p>
          {unfinished > view.attached && (
            <p>
              {unfinished - view.attached} unfinished files need their originals
              reselected.
            </p>
          )}
          <p>
            Server checks still apply. A retry may recover a stored upload; new
            files still require capacity. Pause or cancel stops future requests
            and never deletes uploaded photos.
          </p>
          <ol>
            {queue.items.map((item) => (
              <li key={item.id}>
                <strong>{item.name}</strong>: {item.status}
                {item.error && <span role="alert">. {item.error}</span>}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
