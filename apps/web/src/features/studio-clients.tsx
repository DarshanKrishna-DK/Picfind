import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, HttpError, saveFile, session } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import {
  blankClient,
  clientDirectory,
  clientDirectoryCsv,
  clientFields,
  savedClient,
  type ClientDirectory,
  type ClientFields,
  type SavedClient,
} from '../../../../packages/shared/src/studio-clients';
import './studio-clients.css';

export function StudioClients() {
  const account = useQuery({ queryKey: ['session'], queryFn: session });
  if (account.isPending) return <Loading />;
  if (!account.data || account.error)
    return (
      <ErrorNote
        error={
          account.error ?? new Error('Sign in to view your client directory.')
        }
      />
    );
  return <Directory key={account.data.id} accountId={account.data.id} />;
}
function headers(accountId: string) {
  return { 'X-PicFind-Studio-Actor': accountId };
}
async function readDirectory(accountId: string, signal: AbortSignal) {
  const result = clientDirectory.parse(
    await api('/studio/clients', { signal, headers: headers(accountId) }),
  );
  if (result.accountId !== accountId)
    throw new HttpError(
      403,
      'Your signed-in account changed. Reload the studio.',
    );
  return result;
}
function Directory({ accountId }: { accountId: string }) {
  const query = useQuery({
    queryKey: ['studio-clients', accountId],
    queryFn: ({ signal }) => readDirectory(accountId, signal),
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  if (query.isPending) return <Loading />;
  if (query.error)
    return (
      <section className="glass-panel">
        <h1>Client directory</h1>
        <ErrorNote error={query.error} />
        <button
          type="button"
          className="button"
          onClick={() => void query.refetch()}
        >
          Retry client directory
        </button>
      </section>
    );
  return <ClientEditor key={accountId} initial={query.data} />;
}
function ClientEditor({ initial }: { initial: ClientDirectory }) {
  const [directory, setDirectory] = useState(initial);
  const [draft, setDraft] = useState<ClientFields>(blankClient);
  const [selected, setSelected] = useState<SavedClient | null>(null);
  const [newId, setNewId] = useState(() => crypto.randomUUID());
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [denied, setDenied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  function choose(client: SavedClient | null) {
    setSelected(client);
    setDraft(
      client
        ? {
            name: client.name,
            email: client.email,
            phone: client.phone,
            company: client.company,
          }
        : blankClient(),
    );
    setNewId(crypto.randomUUID());
    setConflict(false);
    setConfirmDelete(false);
    setError(null);
    setMessage('');
  }
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      await action(controller.signal);
    } catch (failure) {
      if (controller.signal.aborted) return;
      setError(failure);
      if (failure instanceof HttpError && failure.code === 'CLIENT_CHANGED')
        setConflict(true);
      if (failure instanceof HttpError && [401, 403].includes(failure.status)) {
        setDenied(true);
        setDirectory({ ...initial, clients: [] });
        setDraft(blankClient());
        setSelected(null);
      }
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (conflict || denied) return;
    await run(async (signal) => {
      const fields = clientFields.parse(draft);
      const result = await api<{ accountId: string; client: unknown }>(
        `/studio/clients/${selected?.id ?? newId}`,
        {
          method: 'PUT',
          signal,
          headers: headers(initial.accountId),
          body: JSON.stringify({ ...fields, version: selected?.version ?? 0 }),
        },
      );
      signal.throwIfAborted();
      if (result.accountId !== initial.accountId)
        throw new HttpError(
          403,
          'Your signed-in account changed. Reload the studio.',
        );
      const client = savedClient.parse(result.client);
      if (client.id !== (selected?.id ?? newId))
        throw new Error(
          'The saved client response did not match this draft. Reload the directory.',
        );
      setDirectory((current) => ({
        ...current,
        clients: [
          ...current.clients.filter((row) => row.id !== client.id),
          client,
        ],
      }));
      choose(client);
      setMessage('Private client saved.');
    });
  }
  async function reload() {
    await run(async (signal) => {
      const result = await readDirectory(initial.accountId, signal);
      signal.throwIfAborted();
      setDirectory(result);
      choose(null);
      setDenied(false);
      setMessage('Latest directory loaded.');
    });
  }
  async function exportCsv() {
    await run(async (signal) => {
      const latest = await readDirectory(initial.accountId, signal);
      signal.throwIfAborted();
      saveFile(
        new Blob(['\ufeff', clientDirectoryCsv(latest.clients)], {
          type: 'text/csv;charset=utf-8',
        }),
        'picfind-private-clients.csv',
      );
      setMessage(
        `CSV download started for ${latest.clients.length} clients. Keep this contact file private.`,
      );
    });
  }
  async function remove() {
    if (!selected || !confirmDelete || conflict || denied) return;
    const target = selected;
    await run(async (signal) => {
      await api(`/studio/clients/${target.id}`, {
        method: 'DELETE',
        signal,
        headers: headers(initial.accountId),
        body: JSON.stringify({ version: target.version }),
      });
      signal.throwIfAborted();
      setDirectory((current) => ({
        ...current,
        clients: current.clients.filter((row) => row.id !== target.id),
      }));
      choose(null);
      setMessage(
        'Client removed from your directory. Existing invitations and exported files are unchanged.',
      );
    });
  }
  if (denied)
    return (
      <section className="glass-panel">
        <h1>Client directory unavailable</h1>
        <ErrorNote error={error} />
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => void reload()}
        >
          Reload client directory
        </button>
      </section>
    );
  const visible = directory.clients
    .filter((client) =>
      [client.name, client.email, client.phone, client.company].some((value) =>
        value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
      ),
    )
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return (
    <section className="glass-panel">
      <h1>Client directory</h1>
      <p>
        Private contacts for your photography work. Saving a contact does not
        send messages or give access to photos.
      </p>
      <p>
        {directory.clients.length} / {directory.limit} clients saved.
      </p>
      <div className="button-row">
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void reload()}
        >
          Load latest directory and discard draft
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void exportCsv()}
        >
          Export private clients CSV
        </button>
      </div>
      <ErrorNote error={error} />
      <p role="status">{message}</p>
      <div className="client-directory-grid">
        <div>
          <label>
            Search clients
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="button"
            disabled={busy || directory.clients.length >= directory.limit}
            onClick={() => choose(null)}
          >
            New client
          </button>
          <p>{visible.length} matching contacts</p>
          <ul className="client-directory-list" aria-label="Saved clients">
            {visible.map((client) => (
              <li key={client.id}>
                <button
                  type="button"
                  disabled={busy}
                  aria-pressed={selected?.id === client.id}
                  onClick={() => choose(client)}
                >
                  <strong>{client.name}</strong>
                  <span>{client.company}</span>
                  <span>
                    {client.email || client.phone || 'No contact details saved'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <form onSubmit={(event) => void save(event)}>
          <h2>{selected ? 'Edit client' : 'New client'}</h2>
          <fieldset disabled={busy}>
            {(
              [
                ['name', 'Client name', 100, 'text'],
                ['email', 'Client email (optional)', 254, 'email'],
                ['phone', 'Client phone (optional)', 40, 'tel'],
                ['company', 'Client company (optional)', 100, 'text'],
              ] as const
            ).map(([field, label, maxLength, type]) => (
              <label key={field}>
                {label}
                <input
                  type={type}
                  maxLength={maxLength}
                  required={field === 'name'}
                  value={draft[field]}
                  onChange={(event) => {
                    setDraft((current) => ({
                      ...current,
                      [field]: event.target.value,
                    }));
                    setConfirmDelete(false);
                  }}
                />
              </label>
            ))}
            <button
              className="button"
              disabled={
                conflict ||
                !draft.name.trim() ||
                (!selected && directory.clients.length >= directory.limit)
              }
            >
              Save private client
            </button>
            {selected && (
              <button
                type="button"
                className="button secondary"
                disabled={conflict}
                onClick={() => setConfirmDelete(true)}
              >
                Remove client
              </button>
            )}
            {confirmDelete && selected && (
              <div role="group" aria-label="Confirm client removal">
                <p>
                  Remove {selected.name} and their contact details from your
                  directory?
                </p>
                <button
                  type="button"
                  className="button danger"
                  onClick={() => void remove()}
                >
                  Confirm remove client
                </button>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setConfirmDelete(false)}
                >
                  Keep client
                </button>
              </div>
            )}
          </fieldset>
          {conflict && (
            <p role="alert">
              Your draft is preserved. Use Load latest directory and discard
              draft before editing the current record.
            </p>
          )}
        </form>
      </div>
    </section>
  );
}
