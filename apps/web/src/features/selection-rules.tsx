import { useEffect, useState, type FormEvent } from 'react';
import {
  validSelectionRules,
  type SelectionCountRules,
} from '../../../../packages/shared/src/selection-rules';
import { api } from '../api';
import { ErrorNote } from '../components/ui';

export function SelectionRulesForm({
  eventId,
  rules,
  refresh,
}: {
  eventId: string;
  rules: SelectionCountRules;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [minimum, setMinimum] = useState(String(rules.minimum));
  const [maximum, setMaximum] = useState(String(rules.maximum));
  useEffect(() => {
    setMinimum(String(rules.minimum));
    setMaximum(String(rules.maximum));
  }, [rules.minimum, rules.maximum]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = {
      minimum: Number(form.get('minimum')),
      maximum: Number(form.get('maximum')),
    };
    setMessage('');
    setError(null);
    if (!validSelectionRules(next)) {
      setError(
        new Error(
          'Use whole numbers from 1 to 100. The minimum must be no greater than the maximum.',
        ),
      );
      return;
    }
    setBusy(true);
    try {
      await api(`/events/${eventId}/selection-rules`, {
        method: 'PATCH',
        body: JSON.stringify(next),
      });
      await refresh();
      setMessage('Selection limits saved for future submissions.');
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="selection-card">
      <summary>Selection count rules</summary>
      <p>
        Set the number of photos guests can send in each request. Use the same
        minimum and maximum for an exact count. Existing requests are preserved.
      </p>
      {!validSelectionRules(rules) && (
        <p className="notice">
          Stored limits are invalid. Guests can view the gallery, but favorites
          submissions are paused until you save valid limits.
        </p>
      )}
      <form onSubmit={(event) => void save(event)}>
        <div className="selection-review-fields">
          <label>
            Minimum favorites per request
            <input
              name="minimum"
              type="number"
              min={1}
              max={100}
              step={1}
              value={minimum}
              onChange={(event) => setMinimum(event.target.value)}
              required
              disabled={busy}
            />
          </label>
          <label>
            Maximum favorites per request
            <input
              name="maximum"
              type="number"
              min={1}
              max={100}
              step={1}
              value={maximum}
              onChange={(event) => setMaximum(event.target.value)}
              required
              disabled={busy}
            />
          </label>
        </div>
        <p className="field-help">
          Limits apply to each submission, not to a person across repeated
          submissions. Choose a minimum that the available gallery can satisfy.
        </p>
        <button className="button secondary" disabled={busy}>
          {busy ? 'Saving limits...' : 'Save selection limits'}
        </button>
        <ErrorNote error={error} />
        <p role="status">{message}</p>
      </form>
    </details>
  );
}
