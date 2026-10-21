import { describe, it, expect } from 'vitest';
const { initialJavascriptFiles, assertWebBundleBudget } = (await import(
  new URL('../../scripts/check-web-bundle.mjs', import.meta.url).href
)) as {
  initialJavascriptFiles: (manifest: unknown) => string[];
  assertWebBundleBudget: (
    measurement: { bytes: number; gzipBytes: number },
    budget?: { bytes: number; gzipBytes: number },
  ) => void;
};
describe('initial route JavaScript budget', () => {
  it('rejects invalid configured limits instead of silently disabling enforcement', () => {
    for (const invalid of [
      NaN,
      Infinity,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() =>
        assertWebBundleBudget(
          { bytes: 1, gzipBytes: 1 },
          { bytes: invalid, gzipBytes: 2 },
        ),
      ).toThrow('budget is invalid');
      expect(() =>
        assertWebBundleBudget(
          { bytes: 1, gzipBytes: 1 },
          { bytes: 2, gzipBytes: invalid },
        ),
      ).toThrow('budget is invalid');
    }
    expect(() =>
      assertWebBundleBudget(
        { bytes: 0, gzipBytes: 0 },
        { bytes: 0, gzipBytes: 0 },
      ),
    ).not.toThrow();
    expect(() =>
      assertWebBundleBudget(
        { bytes: 1, gzipBytes: 0 },
        { bytes: 0, gzipBytes: 0 },
      ),
    ).toThrow('exceeds');
  });
  it('includes transitive static chunks once and excludes deferred routes', () => {
    expect(
      initialJavascriptFiles({
        'index.html': {
          isEntry: true,
          file: 'assets/main.js',
          imports: ['shared', 'same'],
          dynamicImports: ['private'],
        },
        shared: { file: 'assets/shared.js', imports: ['core'] },
        same: { file: 'assets/shared.js', imports: ['core'] },
        core: { file: 'assets/core.js', imports: ['shared'] },
        private: { file: 'assets/private.js', imports: ['large'] },
        large: { file: 'assets/large.js' },
      }),
    ).toEqual(['assets/core.js', 'assets/main.js', 'assets/shared.js']);
  });
  it('fails closed on missing entry, missing static dependency and malformed imports', () => {
    for (const manifest of [
      {},
      { 'index.html': { file: 'main.js' } },
      {
        'index.html': { isEntry: true, file: 'main.js', imports: ['missing'] },
      },
      { 'index.html': { isEntry: true, file: 'main.js', imports: 'private' } },
    ])
      expect(() => initialJavascriptFiles(manifest)).toThrow();
  });
  it('enforces raw and gzip limits separately including exact boundaries', () => {
    expect(() =>
      assertWebBundleBudget({ bytes: 600000, gzipBytes: 200000 }),
    ).not.toThrow();
    expect(() =>
      assertWebBundleBudget({ bytes: 600001, gzipBytes: 1 }),
    ).toThrow('exceeds');
    expect(() =>
      assertWebBundleBudget({ bytes: 1, gzipBytes: 200001 }),
    ).toThrow('exceeds');
    expect(() => assertWebBundleBudget({ bytes: NaN, gzipBytes: 1 })).toThrow(
      'invalid',
    );
  });
});
