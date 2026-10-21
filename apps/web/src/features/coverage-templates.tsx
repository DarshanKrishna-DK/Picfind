import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, HttpError } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import {
  TEMPLATE_ACTOR,
  templateDirectory,
  templateResult,
  templateFromCoverage,
  applyCoverageTemplate,
  type SavedTemplate,
  type TemplateFields,
} from '../../../../packages/shared/src/coverage-templates';
import type { CoverageCategory } from '../../../../packages/shared/src/event-coverage';
import './coverage-templates.css';

export function CoverageTemplates({
  accountId,
  items,
  disabled,
  onApply,
  onBusyChange,
}: {
  accountId: string;
  items: CoverageCategory[];
  disabled: boolean;
  onApply: (fields: TemplateFields, mode: 'append' | 'replace') => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const cache = useQueryClient(),
    key = ['coverage-templates', accountId],
    root = '/studio/coverage-templates';
  const query = useQuery({
    queryKey: key,
    retry: false,
    refetchOnWindowFocus: 'always',
    queryFn: async ({ signal }) => {
      const result = templateDirectory.parse(
        await api(root, { signal, headers: { [TEMPLATE_ACTOR]: accountId } }),
      );
      if (result.accountId !== accountId)
        throw new HttpError(403, 'These templates belong to another account.');
      return result;
    },
  });
  const [title, setTitle] = useState(''),
    [selected, setSelected] = useState<SavedTemplate | null>(null),
    [newId, setNewId] = useState(() => crypto.randomUUID()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [message, setMessage] = useState(''),
    [conflict, setConflict] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      pending.current?.abort();
      onBusyChange(false);
    },
    [onBusyChange],
  );
  const denied = [query.error, error].some(
    (failure) =>
      failure instanceof HttpError && [401, 403].includes(failure.status),
  );
  const stale =
    conflict ||
    !!query.error ||
    !!(
      selected &&
      JSON.stringify(
        query.data?.templates.find((row) => row.id === selected.id),
      ) !== JSON.stringify(selected)
    );
  const blocked = disabled || busy || query.isFetching || stale;
  let source: TemplateFields | null = null,
    appendValid = false;
  try {
    source = templateFromCoverage(title, items);
  } catch {
    /* The editor explains invalid or empty drafts below. */
  }
  if (selected)
    try {
      applyCoverageTemplate(items, selected.fields, 'append', () =>
        crypto.randomUUID(),
      );
      appendValid = true;
    } catch {
      /* Existing bounds prohibit this append. */
    }
  function checked(value: unknown, id: string) {
    const result = templateResult.parse(value);
    if (result.accountId !== accountId || result.template.id !== id)
      throw new HttpError(
        403,
        'This template belongs to another account or record.',
      );
    return result.template;
  }
  function updateCache(value: SavedTemplate | null, id: string) {
    cache.setQueryData(key, (previous: unknown) => {
      const parsed = templateDirectory.safeParse(previous);
      if (!parsed.success) return previous;
      return {
        ...parsed.data,
        templates: [
          ...parsed.data.templates.filter((row) => row.id !== id),
          ...(value ? [value] : []),
        ].sort(
          (a, b) =>
            a.fields.title.localeCompare(b.fields.title) ||
            a.id.localeCompare(b.id),
        ),
      };
    });
  }
  async function refresh() {
    if (busy || disabled || query.isFetching) return;
    const result = await query.refetch();
    if (result.data && !result.error) {
      setSelected(null);
      setConflict(false);
      setError(null);
      setMessage('Templates refreshed. Select a template to review it again.');
    }
  }
  async function run(
    action: 'create' | 'update' | 'delete' | 'append' | 'replace',
  ) {
    if (blocked || pending.current) return;
    if (action !== 'create' && !selected) return;
    if ((action === 'create' || action === 'update') && !source) return;
    if (action === 'append' && !appendValid) return;
    if (
      action === 'delete' &&
      !window.confirm(
        'Remove this reusable template? Existing event plans will stay unchanged.',
      )
    )
      return;
    if (
      action === 'replace' &&
      items.length &&
      !window.confirm(
        'Replace this local coverage draft and clear its photo assignments? The saved event plan stays unchanged until you save it.',
      )
    )
      return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    setMessage('');
    try {
      const id = action === 'create' ? newId : selected!.id;
      if (action === 'append' || action === 'replace') {
        const fresh = checked(
          await api(`${root}/${id}`, {
            signal: controller.signal,
            headers: { [TEMPLATE_ACTOR]: accountId },
          }),
          id,
        );
        controller.signal.throwIfAborted();
        if (JSON.stringify(fresh) !== JSON.stringify(selected))
          throw new HttpError(
            409,
            'The reviewed template changed. Refresh and review it again.',
          );
        onApply(fresh.fields, action);
        setMessage(
          'Template applied to the local draft. Review it and save the event coverage plan explicitly.',
        );
      } else if (action === 'delete') {
        await api(`${root}/${id}`, {
          method: 'DELETE',
          signal: controller.signal,
          headers: { [TEMPLATE_ACTOR]: accountId },
          body: JSON.stringify({
            generation: selected!.generation,
            version: selected!.version,
          }),
        });
        controller.signal.throwIfAborted();
        updateCache(null, id);
        setSelected(null);
        setMessage('Template removed. Existing event plans are unchanged.');
      } else {
        const value = checked(
          await api(`${root}/${id}`, {
            method: 'PUT',
            signal: controller.signal,
            headers: { [TEMPLATE_ACTOR]: accountId },
            body: JSON.stringify({
              fields: source,
              generation: action === 'create' ? null : selected!.generation,
              version: action === 'create' ? 0 : selected!.version,
            }),
          }),
          id,
        );
        controller.signal.throwIfAborted();
        updateCache(value, id);
        setSelected(value);
        setTitle(value.fields.title);
        if (action === 'create') setNewId(crypto.randomUUID());
        setMessage(
          'Reusable template saved. Photo assignments were not copied and the event plan is unchanged.',
        );
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure);
        if (failure instanceof HttpError && [404, 409].includes(failure.status))
          setConflict(true);
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      onBusyChange(false);
      if (pending.current === controller) pending.current = null;
    }
  }
  if (denied) return <ErrorNote error={query.error ?? error} />;
  return (
    <section
      className="coverage-templates"
      aria-label="Reusable coverage templates"
    >
      <h3>Reusable shot lists</h3>
      <p>
        Save category definitions for future events. Templates never copy photos
        or completed assignments.
      </p>
      {query.isPending && <Loading />}
      <ErrorNote error={query.error} />
      <ErrorNote error={error} />
      {message && <p role="status">{message}</p>}
      {stale && (
        <p role="alert">
          Templates changed or could not be refreshed. The event draft is
          preserved. Refresh templates before continuing.
        </p>
      )}
      <button
        type="button"
        className="button secondary"
        disabled={busy || disabled || query.isFetching}
        onClick={() => void refresh()}
      >
        Refresh templates
      </button>
      {query.data && (
        <fieldset disabled={blocked}>
          <legend>Private template library</legend>
          <p>
            {query.data.templates.length} of {query.data.limit} templates saved.
          </p>
          <label>
            Reviewed template
            <select
              value={selected?.id ?? ''}
              onChange={(event) => {
                const value =
                  query.data.templates.find(
                    (row) => row.id === event.target.value,
                  ) ?? null;
                setSelected(value);
                if (value) setTitle(value.fields.title);
                setMessage('');
                setError(null);
              }}
            >
              <option value="">Choose a template</option>
              {query.data.templates.map((row) => (
                <option value={row.id} key={row.id}>
                  {row.fields.title}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <section aria-label="Selected template preview">
              <h4>{selected.fields.title}</h4>
              <ol>
                {selected.fields.categories.map((row) => (
                  <li key={row.label}>
                    <strong>{row.label}</strong>: target {row.target}
                    {row.note && <p>{row.note}</p>}
                  </li>
                ))}
              </ol>
              {!appendValid && (
                <p>
                  Appending would duplicate a category name or exceed the
                  coverage limits. Review the draft or use confirmed
                  replacement.
                </p>
              )}
              <div className="template-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={!appendValid}
                  onClick={() => void run('append')}
                >
                  Append reviewed template
                </button>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void run('replace')}
                >
                  Replace draft with template
                </button>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void run('delete')}
                >
                  Remove template
                </button>
              </div>
            </section>
          )}
          <label>
            Template name
            <input
              maxLength={80}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setMessage('');
              }}
            />
          </label>
          <p>
            Save the current draft categories, targets and notes using this
            name.
          </p>
          {!source && (
            <p>
              Enter a template name and at least one valid draft category. Photo
              assignments are excluded.
            </p>
          )}
          <div className="template-actions">
            <button
              type="button"
              className="button secondary"
              disabled={
                !source || query.data.templates.length >= query.data.limit
              }
              onClick={() => void run('create')}
            >
              Save draft as new template
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={!source || !selected}
              onClick={() => void run('update')}
            >
              Update selected template from draft
            </button>
          </div>
        </fieldset>
      )}
    </section>
  );
}
