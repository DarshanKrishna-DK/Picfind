import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { api, HttpError, saveFile, session } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import {
  clientQuestionnaire,
  ownerQuestionnaires,
  questionnaireCreate,
  questionnaireResponseWrite,
  QUESTIONNAIRE_CONSENT,
  type ClientQuestionnaire,
  type OwnerQuestionnaires,
  type QuestionnaireFields,
} from '../../../../packages/shared/src/studio-questionnaires';
import './project-questionnaires.css';

const headers = (id: string) => ({ 'X-PicFind-Questionnaire-Actor': id });
const uuid = () => crypto.randomUUID();
const blank = (): QuestionnaireFields => ({
  title: 'Shoot preparation',
  introduction: '',
  questions: [
    {
      id: uuid(),
      label: 'Which photographs matter most to you?',
      required: true,
      multiline: true,
    },
  ],
});
const stamp = (value: string) => new Date(value).toLocaleString();
const blocked = (failure: unknown) =>
  failure instanceof HttpError && [401, 403, 404].includes(failure.status);
function useAction() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [denied, setDenied] = useState(false),
    [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function run(operation: (signal: AbortSignal) => Promise<void>) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      await operation(controller.signal);
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure);
        if (blocked(failure)) setDenied(true);
      }
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return { busy, error, denied, message, setMessage, run };
}
async function readOwner(
  accountId: string,
  projectId: string,
  signal: AbortSignal,
) {
  const data = ownerQuestionnaires.parse(
    await api(`/studio/projects/${projectId}/questionnaires`, {
      signal,
      headers: headers(accountId),
    }),
  );
  if (data.accountId !== accountId || data.projectId !== projectId)
    throw new HttpError(
      403,
      'This questionnaire page belongs to another account or project.',
    );
  return data;
}
async function readClient(accountId: string, id: string, signal: AbortSignal) {
  const data = clientQuestionnaire.parse(
    await api(`/questionnaires/${id}`, { signal, headers: headers(accountId) }),
  );
  if (data.accountId !== accountId || data.id !== id)
    throw new HttpError(403, 'This questionnaire belongs to another account.');
  return data;
}
export function ProjectQuestionnaires({
  client = false,
}: {
  client?: boolean;
}) {
  const { projectId = '', id = '' } = useParams();
  const account = useQuery({
    queryKey: ['session'],
    queryFn: session,
    refetchOnWindowFocus: 'always',
    retry: false,
  });
  const path = client
    ? `/questionnaires/${id}`
    : `/app/projects/${projectId}/questionnaires`;
  if (account.isPending) return <Loading />;
  if (account.error) return <ErrorNote error={account.error} />;
  if (!account.data)
    return (
      <section className="wrap standalone questionnaire-page">
        <h1>Sign in to answer your questionnaire</h1>
        <p>Use the verified PicFind account the photographer invited.</p>
        <Link
          className="button"
          to={`/sign-in?returnTo=${encodeURIComponent(path)}`}
        >
          Sign in to continue
        </Link>
      </section>
    );
  return client ? (
    <ClientPage
      key={`${account.data.id}:${id}`}
      accountId={account.data.id}
      id={id}
    />
  ) : (
    <OwnerPage
      key={`${account.data.id}:${projectId}`}
      accountId={account.data.id}
      projectId={projectId}
    />
  );
}
function OwnerPage({
  accountId,
  projectId,
}: {
  accountId: string;
  projectId: string;
}) {
  const query = useQuery({
    queryKey: ['project-questionnaires', accountId, projectId],
    queryFn: ({ signal }) => readOwner(accountId, projectId, signal),
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  if (query.isPending) return <Loading />;
  if (query.error && (!query.data || blocked(query.error)))
    return (
      <section className="glass-panel">
        <h1>Questionnaires unavailable</h1>
        <ErrorNote error={query.error} />
        <button className="button" onClick={() => void query.refetch()}>
          Retry questionnaires
        </button>
      </section>
    );
  if (!query.data) return <Loading />;
  return (
    <OwnerEditor
      data={query.data}
      fetching={query.isFetching}
      readError={query.error}
      refresh={async () => {
        const result = await query.refetch();
        if (result.error) throw result.error;
      }}
    />
  );
}
function OwnerEditor({
  data,
  fetching,
  readError,
  refresh,
}: {
  data: OwnerQuestionnaires;
  fetching: boolean;
  readError: unknown;
  refresh: () => Promise<void>;
}) {
  const action = useAction(),
    [fields, setFields] = useState(blank),
    [email, setEmail] = useState(''),
    [days, setDays] = useState('7'),
    [newId, setNewId] = useState(uuid);
  const root = `/studio/projects/${data.projectId}/questionnaires`,
    disabled = action.busy || fetching;
  function reset() {
    setFields(blank());
    setEmail('');
    setDays('7');
    setNewId(uuid());
  }
  async function issue(event: FormEvent) {
    event.preventDefault();
    await action.run(async (signal) => {
      const input = questionnaireCreate.safeParse({
        ...fields,
        email: email.trim(),
        days: Number(days),
      });
      if (!input.success)
        throw new Error(
          'Check the recipient, expiry and question limits. Shorten the form if it is too large.',
        );
      await api(`${root}/${newId}`, {
        method: 'PUT',
        signal,
        headers: headers(data.accountId),
        body: JSON.stringify(input.data),
      });
      if (signal.aborted) return;
      reset();
      action.setMessage(
        'Questionnaire issued. Copy its link and share it with the assigned client.',
      );
      await refresh();
    });
  }
  async function change(id: string, version: number, remove: boolean) {
    if (
      !window.confirm(
        remove
          ? 'Remove this questionnaire and its saved response? Downloaded copies cannot be recalled.'
          : 'Revoke new answers? The client can still read and withdraw a retained response.',
      )
    )
      return;
    await action.run(async (signal) => {
      await api(`${root}/${id}${remove ? '' : '/revoke'}`, {
        method: remove ? 'DELETE' : 'PUT',
        signal,
        headers: headers(data.accountId),
        body: JSON.stringify({ version }),
      });
      if (!signal.aborted) {
        await refresh();
        action.setMessage(
          remove ? 'Questionnaire removed.' : 'Questionnaire revoked.',
        );
      }
    });
  }
  async function exportBrief(
    row: OwnerQuestionnaires['questionnaires'][number],
  ) {
    await action.run(async (signal) => {
      const latest = await readOwner(data.accountId, data.projectId, signal);
      const current = latest.questionnaires.find(
        (value) => value.questionnaire.id === row.questionnaire.id,
      );
      if (
        !current?.response ||
        current.removalPending ||
        JSON.stringify(current) !== JSON.stringify(row)
      )
        throw new Error(
          'The submitted brief changed or was withdrawn. Reload questionnaires before exporting.',
        );
      const form = current.questionnaire,
        response = current.response;
      const text = [
        form.title,
        `Submitted: ${response.submittedAt}`,
        '',
        ...form.questions.flatMap((q) => [
          q.label,
          response.answers.find((a) => a.questionId === q.id)!.text ||
            '(No answer)',
          '',
        ]),
        'Private client brief. This static copy cannot be recalled after withdrawal.',
      ].join('\n');
      if (!signal.aborted) {
        saveFile(
          new Blob([text], { type: 'text/plain;charset=utf-8' }),
          'picfind-client-brief.txt',
        );
        action.setMessage('Submitted brief exported as a private text file.');
      }
    });
  }
  if (action.denied) return <ErrorNote error={action.error} />;
  return (
    <section className="glass-panel questionnaire-page">
      <Link to="/app/projects">Back to projects</Link>
      <p className="eyebrow">Client preparation</p>
      <h1>{data.projectName}: questionnaires</h1>
      <p>
        Ask a verified client for a preparation brief. Draft answers stay
        private until the client submits them.
      </p>
      <ErrorNote error={action.error} />
      <ErrorNote error={readError} />
      <p role="status">{action.message}</p>
      <div className="questionnaire-actions">
        <button
          className="button secondary"
          disabled={disabled}
          onClick={() =>
            void action.run(async () => {
              await refresh();
            })
          }
        >
          Reload questionnaires
        </button>
      </div>
      <form onSubmit={issue} className="questionnaire-card">
        <h2>Issue a questionnaire</h2>
        <p>
          Questions and recipient cannot change after issue. Links do not send
          messages or grant photo access.
        </p>
        {!data.editable && (
          <p role="status">
            This project is archived or being removed. New questionnaires are
            closed.
          </p>
        )}
        <fieldset
          disabled={
            disabled ||
            !!readError ||
            !data.editable ||
            data.questionnaires.length >= data.limit
          }
        >
          <label>
            Title
            <input
              required
              maxLength={100}
              value={fields.title}
              onChange={(e) => setFields({ ...fields, title: e.target.value })}
            />
          </label>
          <label>
            Introduction
            <textarea
              maxLength={500}
              value={fields.introduction}
              onChange={(e) =>
                setFields({ ...fields, introduction: e.target.value })
              }
            />
          </label>
          <div className="questionnaire-grid">
            <label>
              Client email
              <input
                type="email"
                required
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label>
              Expires after days
              <input
                type="number"
                min={1}
                max={30}
                required
                value={days}
                onChange={(e) => setDays(e.target.value)}
              />
            </label>
          </div>
          {fields.questions.map((question, index) => (
            <div className="questionnaire-question" key={question.id}>
              <label>
                Question {index + 1}
                <input
                  required
                  maxLength={160}
                  value={question.label}
                  onChange={(e) =>
                    setFields({
                      ...fields,
                      questions: fields.questions.map((q) =>
                        q.id === question.id
                          ? { ...q, label: e.target.value }
                          : q,
                      ),
                    })
                  }
                />
              </label>
              <div className="questionnaire-actions">
                <label className="questionnaire-check">
                  <input
                    type="checkbox"
                    checked={question.required}
                    onChange={(e) =>
                      setFields({
                        ...fields,
                        questions: fields.questions.map((q) =>
                          q.id === question.id
                            ? { ...q, required: e.target.checked }
                            : q,
                        ),
                      })
                    }
                  />
                  Required answer
                </label>
                <label className="questionnaire-check">
                  <input
                    type="checkbox"
                    checked={question.multiline}
                    onChange={(e) =>
                      setFields({
                        ...fields,
                        questions: fields.questions.map((q) =>
                          q.id === question.id
                            ? { ...q, multiline: e.target.checked }
                            : q,
                        ),
                      })
                    }
                  />
                  Long answer
                </label>
                <button
                  type="button"
                  className="button secondary"
                  disabled={fields.questions.length === 1}
                  onClick={() =>
                    setFields({
                      ...fields,
                      questions: fields.questions.filter(
                        (q) => q.id !== question.id,
                      ),
                    })
                  }
                >
                  Remove question {index + 1}
                </button>
              </div>
            </div>
          ))}
          <div className="questionnaire-actions">
            <button
              type="button"
              className="button secondary"
              disabled={fields.questions.length >= 10}
              onClick={() =>
                setFields({
                  ...fields,
                  questions: [
                    ...fields.questions,
                    { id: uuid(), label: '', required: false, multiline: true },
                  ],
                })
              }
            >
              Add question
            </button>
            <button className="button" type="submit">
              Issue questionnaire
            </button>
          </div>
        </fieldset>
        <button
          type="button"
          className="button secondary"
          disabled={disabled}
          onClick={() => {
            if (window.confirm('Discard this unsent form and start again?'))
              reset();
          }}
        >
          Discard unsent form
        </button>
      </form>
      <h2>
        Issued questionnaires ({data.questionnaires.length} / {data.limit})
      </h2>
      {data.questionnaires.length === 0 && (
        <p>No questionnaires have been issued for this project.</p>
      )}
      {data.questionnaires.map((row) => {
        const form = row.questionnaire,
          closed = !!form.revokedAt || Date.parse(form.expiresAt) <= Date.now();
        return (
          <article className="questionnaire-card" key={form.id}>
            <h3>{form.title}</h3>
            <p>{form.recipientEmail}</p>
            <p>
              {row.removalPending
                ? 'Removal pending'
                : form.revokedAt
                  ? 'Revoked'
                  : closed
                    ? 'Expired'
                    : 'Open'}{' '}
              · Expires {stamp(form.expiresAt)}
            </p>
            <label>
              Client questionnaire link
              <input
                readOnly
                value={
                  new URL(`/questionnaires/${form.id}`, window.location.origin)
                    .href
                }
              />
            </label>
            <div className="questionnaire-actions">
              <button
                className="button secondary"
                disabled={disabled || row.removalPending}
                onClick={() =>
                  void action.run(async (signal) => {
                    await navigator.clipboard.writeText(
                      new URL(
                        `/questionnaires/${form.id}`,
                        window.location.origin,
                      ).href,
                    );
                    if (!signal.aborted)
                      action.setMessage(
                        'Client link copied. Only the assigned account can open it.',
                      );
                  })
                }
              >
                Copy client link
              </button>
              {!closed && (
                <button
                  className="button secondary"
                  disabled={disabled}
                  onClick={() => void change(form.id, form.version, false)}
                >
                  Revoke questionnaire
                </button>
              )}
              {(closed || row.removalPending) && (
                <button
                  className="button danger"
                  disabled={disabled}
                  onClick={() => void change(form.id, form.version, true)}
                >
                  {row.removalPending
                    ? 'Retry removal'
                    : 'Remove questionnaire'}
                </button>
              )}
            </div>
            {row.response && !row.removalPending ? (
              <section aria-label={`Submitted brief for ${form.title}`}>
                <h4>Submitted brief</h4>
                <p>Submitted {stamp(row.response.submittedAt!)}</p>
                <dl>
                  {form.questions.map((q) => (
                    <div key={q.id}>
                      <dt>{q.label}</dt>
                      <dd>
                        {row.response!.answers.find(
                          (a) => a.questionId === q.id,
                        )!.text || 'No answer'}
                      </dd>
                    </div>
                  ))}
                </dl>
                <button
                  className="button secondary"
                  disabled={disabled}
                  onClick={() => void exportBrief(row)}
                >
                  Export submitted brief
                </button>
                <p>
                  Keep exported answers private. Downloads cannot be recalled
                  after a client withdraws.
                </p>
              </section>
            ) : (
              <p>
                No submitted brief is available. Private drafts are never shown
                here.
              </p>
            )}
          </article>
        );
      })}
    </section>
  );
}
function ClientPage({ accountId, id }: { accountId: string; id: string }) {
  const cache = useQueryClient(),
    queryKey = ['client-questionnaire', accountId, id];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => readClient(accountId, id, signal),
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  if (query.isPending) return <Loading />;
  if (query.error && (!query.data || blocked(query.error)))
    return (
      <section className="wrap standalone questionnaire-page">
        <h1>Questionnaire unavailable</h1>
        <ErrorNote error={query.error} />
        <button className="button" onClick={() => void query.refetch()}>
          Retry questionnaire
        </button>
      </section>
    );
  if (!query.data) return <Loading />;
  return (
    <ClientEditor
      initial={query.data}
      live={query.data}
      fetching={query.isFetching}
      readError={query.error}
      onSnapshot={(value) => cache.setQueryData(queryKey, value)}
    />
  );
}
function answersOf(value: ClientQuestionnaire) {
  return (
    value.response?.answers ??
    value.fields.questions.map((q) => ({ questionId: q.id, text: '' }))
  );
}
function ClientEditor({
  initial,
  live,
  fetching,
  readError,
  onSnapshot,
}: {
  initial: ClientQuestionnaire;
  live: ClientQuestionnaire;
  fetching: boolean;
  readError: unknown;
  onSnapshot: (value: ClientQuestionnaire) => void;
}) {
  const action = useAction(),
    [saved, setSaved] = useState(initial),
    [answers, setAnswers] = useState(() => answersOf(initial)),
    [consent, setConsent] = useState(false);
  const stale = JSON.stringify(saved) !== JSON.stringify(live),
    dirty = JSON.stringify(answers) !== JSON.stringify(answersOf(saved)),
    submitted = saved.response?.state === 'submitted',
    disabled = action.busy || fetching;
  const root = `/questionnaires/${saved.id}`;
  function adopt(value: ClientQuestionnaire) {
    setSaved(value);
    setAnswers(answersOf(value));
    setConsent(false);
    onSnapshot(value);
  }
  async function reload() {
    if (
      dirty &&
      !window.confirm(
        'Discard unsaved answers and load the latest saved response?',
      )
    )
      return;
    await action.run(async (signal) => {
      const value = await readClient(saved.accountId, saved.id, signal);
      if (!signal.aborted) adopt(value);
    });
  }
  async function write(submit: boolean) {
    if (
      submit &&
      !window.confirm(
        'Submit these answers to the photographer? Submitted answers cannot be edited. You can withdraw them later.',
      )
    )
      return;
    await action.run(async (signal) => {
      const input = questionnaireResponseWrite.safeParse({
        version: saved.response?.version ?? 0,
        generation: saved.response?.generation ?? null,
        answers,
        action: submit ? 'submit' : 'save',
        consent: submit && consent ? QUESTIONNAIRE_CONSENT : null,
      });
      if (!input.success)
        throw new Error(
          'Check your answer lengths and sharing acknowledgment. Shorten the response if it exceeds the total limit.',
        );
      const value = clientQuestionnaire.parse(
        await api(`${root}/response`, {
          method: 'PUT',
          signal,
          headers: headers(saved.accountId),
          body: JSON.stringify(input.data),
        }),
      );
      if (value.accountId !== saved.accountId || value.id !== saved.id)
        throw new HttpError(403, 'Your signed-in account changed.');
      if (!signal.aborted) {
        adopt(value);
        action.setMessage(
          submit
            ? 'Answers submitted to the photographer.'
            : 'Private draft saved. The photographer cannot see these answers yet.',
        );
      }
    });
  }
  async function withdraw() {
    if (
      !saved.response ||
      !window.confirm(
        'Withdraw and delete your saved answers? Copies already exported by the photographer cannot be recalled.',
      )
    )
      return;
    await action.run(async (signal) => {
      await api(`${root}/response`, {
        method: 'DELETE',
        signal,
        headers: headers(saved.accountId),
        body: JSON.stringify({
          version: saved.response!.version,
          generation: saved.response!.generation,
        }),
      });
      if (!signal.aborted) {
        adopt({ ...saved, response: null });
        action.setMessage(
          'Saved answers withdrawn and removed. Exported copies cannot be recalled.',
        );
      }
    });
  }
  if (action.denied)
    return (
      <section className="wrap standalone">
        <ErrorNote error={action.error} />
      </section>
    );
  return (
    <section className="wrap standalone questionnaire-page">
      <p className="eyebrow">Private client preparation</p>
      <h1>{saved.fields.title}</h1>
      <p>{saved.fields.introduction}</p>
      <p>Expires {stamp(saved.expiresAt)}</p>
      <p>
        Draft answers stay private. Submitting shares them with the
        photographer. Avoid sensitive personal details.
      </p>
      <ErrorNote error={action.error} />
      <ErrorNote error={readError} />
      <p role="status">{action.message}</p>
      {stale && (
        <p role="alert">
          The saved questionnaire changed. Your draft is preserved. Reload
          before saving.
        </p>
      )}
      {!live.accepting && (
        <p role="status">
          New answers are closed. You can still withdraw your saved response.
        </p>
      )}
      {submitted && (
        <p role="status">
          Submitted. These answers are read-only. Ask the photographer for a new
          questionnaire if changes are needed.
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void write(false);
        }}
      >
        <fieldset
          disabled={
            disabled || !!readError || stale || !live.accepting || submitted
          }
        >
          {saved.fields.questions.map((q) => (
            <label key={q.id}>
              {q.label}
              {q.required ? ' (required for submission)' : ' (optional)'}
              {q.multiline ? (
                <textarea
                  maxLength={1000}
                  value={answers.find((a) => a.questionId === q.id)!.text}
                  onChange={(e) => {
                    setAnswers(
                      answers.map((a) =>
                        a.questionId === q.id
                          ? { ...a, text: e.target.value }
                          : a,
                      ),
                    );
                    setConsent(false);
                  }}
                />
              ) : (
                <input
                  maxLength={1000}
                  value={answers.find((a) => a.questionId === q.id)!.text}
                  onChange={(e) => {
                    setAnswers(
                      answers.map((a) =>
                        a.questionId === q.id
                          ? { ...a, text: e.target.value }
                          : a,
                      ),
                    );
                    setConsent(false);
                  }}
                />
              )}
            </label>
          ))}
          <label className="questionnaire-check">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            I agree to share these answers with the photographer when I submit.
          </label>
          <div className="questionnaire-actions">
            <button className="button secondary" type="submit">
              Save private draft
            </button>
            <button
              className="button"
              type="button"
              disabled={
                !consent ||
                saved.fields.questions.some(
                  (q) =>
                    q.required &&
                    !answers.find((a) => a.questionId === q.id)?.text.trim(),
                )
              }
              onClick={() => void write(true)}
            >
              Submit answers
            </button>
          </div>
        </fieldset>
      </form>
      <div className="questionnaire-actions">
        <button
          className="button secondary"
          disabled={disabled}
          onClick={() => void reload()}
        >
          Reload saved response
        </button>
        {saved.response && (
          <button
            className="button danger"
            disabled={disabled || stale}
            onClick={() => void withdraw()}
          >
            Withdraw saved answers
          </button>
        )}
      </div>
      <p>
        Withdrawing removes the saved answers from PicFind. Previously
        downloaded copies cannot be recalled.
      </p>
    </section>
  );
}
