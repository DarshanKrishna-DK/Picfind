export interface ProcessingPollerStatus {
  enabled: boolean;
  running: boolean;
  lastSuccessAt?: string;
  error?: string;
}

/** One process, one operation at a time. Idle storage queries back off. */
export function startAdaptivePoller(
  operation: () => Promise<boolean>,
  options: { minimumMs?: number; maximumMs?: number } = {},
) {
  const minimum = options.minimumMs ?? 2000;
  const maximum = options.maximumMs ?? 30000;
  if (minimum < 1 || maximum < minimum)
    throw new Error('Invalid processing poll interval.');
  const state: ProcessingPollerStatus = { enabled: true, running: false };
  let delay = minimum;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  let stopped = false;
  let wakeRequested = false;

  function schedule(milliseconds: number) {
    if (stopped) return;
    timer = setTimeout(run, milliseconds);
    timer.unref?.();
  }

  function run() {
    timer = undefined;
    if (stopped || active) return;
    state.running = true;
    active = Promise.resolve()
      .then(operation)
      .then((worked) => {
        state.lastSuccessAt = new Date().toISOString();
        delete state.error;
        delay = worked ? minimum : Math.min(maximum, delay * 2);
      })
      .catch(() => {
        state.error = 'Background processing is temporarily unavailable.';
        delay = Math.min(maximum, delay * 2);
      })
      .finally(() => {
        state.running = false;
        active = undefined;
        const next = wakeRequested ? 0 : delay;
        wakeRequested = false;
        schedule(next);
      });
  }

  schedule(0);
  return {
    status: (): ProcessingPollerStatus => ({ ...state }),
    wake() {
      if (stopped) return;
      delay = minimum;
      if (active) {
        wakeRequested = true;
        return;
      }
      if (timer) clearTimeout(timer);
      schedule(0);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await active;
    },
  };
}
