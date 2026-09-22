/** Local liveness only; this does not certify provider configuration or launch readiness. */
export async function waitForStartup({
  fetch = globalThis.fetch,
  pause = () => new Promise((resolve) => setTimeout(resolve, 1000)),
  isStopping = () => false,
  attempts = 30,
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (isStopping()) return false;
    try {
      const page = await fetch('http://127.0.0.1:5173', {
        signal: AbortSignal.timeout(1500),
        redirect: 'error',
      });
      await page.body?.cancel();
      if (page.ok) {
        const response = await fetch('http://127.0.0.1:5173/health', {
          signal: AbortSignal.timeout(1500),
          redirect: 'error',
        });
        if (response.ok) {
          const health = await response.json();
          if (health.service === 'PicFind' && health.status === 'alive')
            return !isStopping();
        } else {
          await response.body?.cancel();
        }
      }
    } catch {
      // Vite and the API may become available at different times.
    }
    if (attempt + 1 < attempts && !isStopping()) await pause();
  }
  if (isStopping()) return false;
  throw new Error(
    'PicFind startup timed out: the web page and API did not both respond. Check the errors above and your local provider configuration, then run the launcher again.',
  );
}
