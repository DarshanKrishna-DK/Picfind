import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkPullRequestSize(value: unknown) {
  if (!value || typeof value !== 'object')
    throw new Error('Pull request size metadata is missing.');
  const { additions, deletions } = value as Record<string, unknown>;
  for (const count of [additions, deletions]) {
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
      throw new Error('Pull request size metadata is invalid.');
  }
  const added = additions as number;
  const removed = deletions as number;
  const total = added + removed;
  if (!Number.isSafeInteger(total) || total >= 5000)
    throw new Error(
      `Pull requests must change fewer than 5,000 lines. Found ${total} additions plus deletions. Split the work into independently useful changes.`,
    );
  return { added, removed, total };
}

export async function checkCurrentPullRequest(
  repository: string,
  number: number,
  token: string,
  request: typeof fetch = fetch,
) {
  if (
    !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    !token
  )
    throw new Error(
      'A repository, pull request number and read token are required.',
    );
  const response = await request(
    `https://api.github.com/repos/${repository}/pulls/${number}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok)
    throw new Error(
      `Cannot verify pull request size: GitHub HTTP ${response.status}.`,
    );
  return checkPullRequestSize(await response.json());
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath) throw new Error('A GitHub pull request event is required.');
    const event = JSON.parse(readFileSync(eventPath, 'utf8')) as {
      number: number;
      pull_request?: unknown;
    };
    if (!event.pull_request)
      throw new Error('This is not a pull request event.');
    const result = await checkCurrentPullRequest(
      process.env.GITHUB_REPOSITORY ?? '',
      event.number,
      process.env.GITHUB_TOKEN ?? '',
    );
    console.log(
      `PR #${event.number}: ${result.added} added + ${result.removed} removed = ${result.total} changed lines (limit: fewer than 5,000).`,
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'PR size check failed.',
    );
    process.exitCode = 1;
  }
}
