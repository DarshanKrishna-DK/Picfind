import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  blankService,
  decimalToMinor,
  minorToDecimal,
  savedService,
  serviceCsv,
  serviceWrite,
  servicePrice,
} from '../../packages/shared/src/studio-services';

describe('service catalog currency and export boundaries', () => {
  it.each([
    ['0', 0],
    ['0.01', 1],
    ['1.1', 110],
    ['2500.09', 250009],
    ['10000000.00', 1000000000],
  ])(
    'parses decimal %s without floating-point multiplication',
    (input, expected) => {
      expect(decimalToMinor(input as string)).toBe(expected);
      expect(decimalToMinor(minorToDecimal(expected as number))).toBe(expected);
    },
  );
  it.each([
    '',
    '-1',
    '+1',
    '1e3',
    '.2',
    '1.',
    '1.001',
    '1,000',
    '10000000.01',
    'Infinity',
    '0x10',
  ])('rejects ambiguous or excessive amount %s', (value) =>
    expect(decimalToMinor(value)).toBeNull(),
  );
  it('requires explicit numeric values and quote-only packages have no stored amount', () => {
    const value = { ...blankService(), title: 'Session', version: 0 };
    expect(serviceWrite.safeParse(value).success).toBe(true);
    for (const patch of [
      { version: '0' },
      { amountMinor: 100 },
      { pricingMode: 'fixed' },
      { currency: 'JPY' },
      { durationMinutes: 0 },
    ])
      expect(serviceWrite.safeParse({ ...value, ...patch }).success).toBe(
        false,
      );
    expect(
      serviceWrite.safeParse({ ...value, pricingMode: 'fixed', amountMinor: 0 })
        .success,
    ).toBe(true);
    expect(servicePrice(value)).toBe('Request a quote');
  });
  it('escapes formulas and preserves Unicode, quoted multiline fields and exact minor units', () => {
    const now = new Date().toISOString();
    const row = savedService.parse({
      ...blankService(),
      id: randomUUID(),
      title: '=SUM(A1)',
      description: 'पहली पंक्ति\n"Second line"',
      deliverables: ['+Edited photos', 'Print "guide"'],
      pricingMode: 'fixed',
      amountMinor: 12345,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const csv = serviceCsv([row]);
    expect(csv.startsWith('\ufeff')).toBe(true);
    expect(csv).toContain(`"'=SUM(A1)"`);
    expect(csv).toContain(`"'+Edited photos\nPrint ""guide"""`);
    expect(csv).toContain('"पहली पंक्ति\n""Second line"""');
    expect(csv).toContain('"INR","12345","no","1"');
    expect(servicePrice(row)).toContain('123.45');
  });
  it('rejects a valid-character payload that exceeds the UTF-8 budget', () => {
    expect(
      serviceWrite.safeParse({
        ...blankService(),
        title: 'Session',
        version: 0,
        description: 'अ'.repeat(2000),
        deliverables: Array.from({ length: 20 }, () => 'अ'.repeat(200)),
      }).success,
    ).toBe(false);
  });
});
