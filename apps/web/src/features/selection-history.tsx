import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { SelectionReceiptPage } from '../../../../packages/shared/src/proofing';
import { api } from '../api';
import { ErrorNote, Loading } from '../components/ui';

export function SelectionHistory({
  eventId,
  accountId,
}: {
  eventId: string;
  accountId: string;
}) {
  const [open, setOpen] = useState(false);
  const history = useInfiniteQuery({
    queryKey: ['selection-history', eventId, accountId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api<SelectionReceiptPage>(
        `/public/events/${eventId}/my-selections${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`,
        { signal },
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: open,
    retry: false,
    gcTime: 0,
  });
  const receipts = history.data?.pages.flatMap((page) => page.receipts) ?? [];
  return (
    <section className="wrap" aria-label="Your selection history">
      <details
        className="source-panel"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>Your previous requests</summary>
        {open && (
          <>
            <p>
              Requests sent from this account. A receipt confirms submission,
              not photographer approval. Older requests may not have an account
              receipt.
            </p>
            <button
              className="button secondary"
              disabled={history.isFetching}
              onClick={() => void history.refetch()}
            >
              Refresh request history
            </button>
            {history.isPending && <Loading />}
            <ErrorNote error={history.error} />
            {!history.isPending && !history.error && (
              <>
                {receipts.length === 0 && (
                  <p>No saved requests for this account.</p>
                )}
                <ul className="selection-list">
                  {receipts.map((receipt) => (
                    <li className="selection-card" key={receipt.id}>
                      <h3>Request from {receipt.name}</h3>
                      <p>
                        <time dateTime={receipt.createdAt}>
                          {new Date(receipt.createdAt).toLocaleString()}
                        </time>
                      </p>
                      <p>{receipt.originalCount} favorites submitted</p>
                      {receipt.note && <p>{receipt.note}</p>}
                      <ul aria-label="Requested filenames">
                        {receipt.photos.map((photo) => (
                          <li key={photo.id}>{photo.filename}</li>
                        ))}
                      </ul>
                      {receipt.unavailableCount > 0 && (
                        <p>
                          {receipt.unavailableCount} photos are no longer
                          available.
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
                {history.hasNextPage && (
                  <button
                    className="button secondary"
                    disabled={history.isFetching}
                    onClick={() => void history.fetchNextPage()}
                  >
                    Load older requests
                  </button>
                )}
              </>
            )}
          </>
        )}
      </details>
    </section>
  );
}
