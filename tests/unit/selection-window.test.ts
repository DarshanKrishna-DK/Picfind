import { describe, expect, it } from 'vitest';
import { selectionWindow } from '../../packages/shared/src/selection-window.js';

const now = Date.parse('2026-10-20T12:00:00.000Z');
describe('submission window', () => {
  it.each([undefined, ''])('keeps legacy events open with %s', (value) => {
    expect(selectionWindow(value, now)).toEqual({
      closesAt: null,
      closed: false,
      invalid: false,
      serverNow: '2026-10-20T12:00:00.000Z',
    });
  });
  it('closes exactly at the server deadline', () => {
    const deadline = new Date(now + 1000).toISOString();
    expect(selectionWindow(deadline, now + 999).closed).toBe(false);
    expect(selectionWindow(deadline, now + 1000).closed).toBe(true);
    expect(selectionWindow(deadline, now + 1001).closed).toBe(true);
  });
  it.each(['invalid', '2027-02-30T12:00:00.000Z', '2027', null, 0, false])(
    'fails closed for corrupt stored metadata: %s',
    (value) => {
      expect(selectionWindow(value, now)).toMatchObject({
        closesAt: null,
        closed: true,
        invalid: true,
      });
    },
  );
});
