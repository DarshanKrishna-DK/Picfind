// A route can change before React runs an unmount effect. Check the URL as
// well as the request signal before committing a downloaded private snapshot.
export function exportNavigationGuard(controller: AbortController) {
  const location = window.location.pathname + window.location.search;
  return () => {
    if (window.location.pathname + window.location.search !== location)
      throw new DOMException(
        'The page changed before the export completed. Retry from the current view.',
        'AbortError',
      );
    controller.signal.throwIfAborted();
  };
}
