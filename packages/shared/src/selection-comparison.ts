import type { EventSelection } from './proofing.js';

export const COMPARISON_FILTERS = ['all', 'shared', 'first', 'second'] as const;
export type ComparisonFilter = (typeof COMPARISON_FILTERS)[number];
type Selection = Pick<EventSelection, 'id' | 'photoIds' | 'photos'>;
export interface ComparedPhoto {
  id: string;
  filename: string;
  selectedBy: 'both' | 'first' | 'second';
}

/** Compare submissions, not people. Names are neither unique nor verified. */
export function compareSelections(first: Selection, second: Selection) {
  if (first.id === second.id)
    throw new Error('Choose two different selection requests.');
  const firstIds = new Set(first.photoIds);
  const secondIds = new Set(second.photoIds);
  const available = new Map<string, { id: string; filename: string }>();
  for (const selection of [first, second]) {
    const selected = new Set(selection.photoIds);
    for (const photo of selection.photos) {
      if (selected.has(photo.id)) available.set(photo.id, photo);
    }
  }
  const ids = new Set([...firstIds, ...secondIds]);
  const photos: ComparedPhoto[] = [];
  for (const id of ids) {
    const photo = available.get(id);
    if (!photo) continue;
    photos.push({
      id,
      filename: photo.filename,
      selectedBy:
        firstIds.has(id) && secondIds.has(id)
          ? 'both'
          : firstIds.has(id)
            ? 'first'
            : 'second',
    });
  }
  photos.sort(
    (a, b) => a.filename.localeCompare(b.filename) || a.id.localeCompare(b.id),
  );
  return {
    photos,
    unavailable: ids.size - photos.length,
    shared: photos.filter((photo) => photo.selectedBy === 'both').length,
  };
}

export function filterComparedPhotos(
  photos: readonly ComparedPhoto[],
  filter: ComparisonFilter,
) {
  return photos.filter(
    (photo) =>
      filter === 'all' ||
      photo.selectedBy === (filter === 'shared' ? 'both' : filter),
  );
}
