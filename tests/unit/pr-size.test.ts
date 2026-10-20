import { describe, expect, it, vi } from 'vitest';
import {
  checkCurrentPullRequest,
  checkPullRequestSize,
} from '../../scripts/check-pr-size';

describe('strict pull request diff budget', () => {
  it('counts removals and accepts only fewer than 5,000 changed lines', () => {
    expect(checkPullRequestSize({ additions: 4000, deletions: 999 })).toEqual({
      added: 4000,
      removed: 999,
      total: 4999,
    });
    expect(() =>
      checkPullRequestSize({ additions: 4000, deletions: 1000 }),
    ).toThrow('fewer than 5,000');
    expect(() =>
      checkPullRequestSize({ additions: 1, deletions: 5000 }),
    ).toThrow();
  });

  it.each([
    undefined,
    {},
    { additions: '1', deletions: 0 },
    { additions: -1, deletions: 0 },
    { additions: NaN, deletions: 0 },
    { additions: 0.5, deletions: 0 },
  ])('fails closed for missing or invalid metadata %#', (value) => {
    expect(() => checkPullRequestSize(value)).toThrow();
  });

  it('uses authenticated aggregate PR metadata and does not follow redirects', async () => {
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ additions: 310, deletions: 20 }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    expect(
      await checkCurrentPullRequest(
        'example/repo',
        8,
        'synthetic-token',
        request,
      ),
    ).toEqual({ added: 310, removed: 20, total: 330 });
    expect(request).toHaveBeenCalledWith(
      'https://api.github.com/repos/example/repo/pulls/8',
      expect.objectContaining({
        redirect: 'error',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('does not treat API failure as an empty diff or expose its response', async () => {
    const request = vi.fn<typeof fetch>(
      async () => new Response('private response', { status: 403 }),
    );
    await expect(
      checkCurrentPullRequest('example/repo', 8, 'synthetic-token', request),
    ).rejects.toThrow('GitHub HTTP 403');
  });

  it('rejects incomplete context before making a request', async () => {
    const request = vi.fn<typeof fetch>();
    await expect(
      checkCurrentPullRequest('example/repo', 8, '', request),
    ).rejects.toThrow();
    await expect(
      checkCurrentPullRequest('example/repo/other', 8, 'token', request),
    ).rejects.toThrow();
    await expect(
      checkCurrentPullRequest('example/repo', -1, 'token', request),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
