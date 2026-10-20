export type SelectionExportFormat = 'txt' | 'csv';

/** Accept only the server-projected, currently available selection photos. */
export function exportSelectionFilenames(
  photos: ReadonlyArray<{ id: string; filename: string }>,
  format: SelectionExportFormat,
) {
  if (!photos.length)
    throw new Error('No selected photos are currently available to export.');
  const unique = [
    ...new Map(photos.map((photo) => [photo.id, photo])).values(),
  ];
  if (unique.some((photo) => photo.filename.includes('\0')))
    throw new Error('A filename contains an unsupported null character.');
  if (format === 'txt' && unique.some((photo) => /[\r\n]/.test(photo.filename)))
    throw new Error(
      'A filename contains a line break or unsupported character. Use CSV to preserve the filenames.',
    );
  const names = unique.map((photo) => photo.filename);
  const counts = new Map<string, number>();
  for (const name of names) {
    const key = name.toLocaleLowerCase('en-US');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const duplicateNames = [...counts.values()].some((count) => count > 1);
  function cell(value: string) {
    // Quote CSV syntax and neutralize formulas, including leading whitespace.
    const safe =
      /^\s*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value)
        ? `'${value}`
        : value;
    return `"${safe.replaceAll('"', '""')}"`;
  }
  return {
    content:
      format === 'txt'
        ? `${names.join('\r\n')}\r\n`
        : [
            ['Photo ID', 'Filename'].map(cell).join(','),
            ...unique.map((photo) =>
              [photo.id, photo.filename].map(cell).join(','),
            ),
          ].join('\r\n') + '\r\n',
    count: unique.length,
    duplicateNames,
  };
}
