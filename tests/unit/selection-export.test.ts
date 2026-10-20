import { describe, expect, it } from 'vitest';
import { exportSelectionFilenames } from '../../packages/shared/src/selection-export';

describe('selection filename exports', () => {
  it('preserves exact names and order while removing repeated photo IDs', () => {
    expect(
      exportSelectionFilenames(
        [
          { id: 'a', filename: 'शादी 01.JPG' },
          { id: 'b', filename: 'Garden, final.jpg' },
          { id: 'a', filename: 'शादी 01.JPG' },
        ],
        'txt',
      ),
    ).toEqual({
      content: 'शादी 01.JPG\r\nGarden, final.jpg\r\n',
      count: 2,
      duplicateNames: false,
    });
  });

  it('keeps distinct photos with duplicate names and flags ambiguity', () => {
    const output = exportSelectionFilenames(
      [
        { id: 'a', filename: 'DSC001.JPG' },
        { id: 'b', filename: 'dsc001.jpg' },
      ],
      'csv',
    );
    expect(output.duplicateNames).toBe(true);
    expect(output.content).toContain('"a","DSC001.JPG"');
    expect(output.content).toContain('"b","dsc001.jpg"');
  });

  it.each(['=1+1', ' +SUM(1)', '-1', '@SUM(1)', '\tformula', '\rformula'])(
    'neutralizes spreadsheet formulas in %j',
    (filename) => {
      expect(
        exportSelectionFilenames([{ id: 'a', filename }], 'csv').content,
      ).toContain(`"'${filename}"`);
    },
  );

  it('escapes CSV quotes, commas and newlines without splitting TXT records', () => {
    const photos = [{ id: 'a', filename: 'first,"second"\nthird.jpg' }];
    expect(exportSelectionFilenames(photos, 'csv').content).toContain(
      '"first,""second""\nthird.jpg"',
    );
    expect(() => exportSelectionFilenames(photos, 'txt')).toThrow('Use CSV');
  });

  it.each(['txt', 'csv'] as const)(
    'rejects null characters in %s',
    (format) => {
      expect(() =>
        exportSelectionFilenames([{ id: 'a', filename: 'bad\0.jpg' }], format),
      ).toThrow('null character');
    },
  );

  it('does not generate a misleading empty export', () => {
    expect(() => exportSelectionFilenames([], 'txt')).toThrow(
      'No selected photos',
    );
  });
});
