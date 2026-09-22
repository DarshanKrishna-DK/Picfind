import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function applyAwsCliCredentials() {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
    return;
  try {
    const { stdout } = await execFileAsync(
      'aws',
      ['configure', 'export-credentials', '--format', 'process'],
      { timeout: 20_000, windowsHide: true },
    );
    const parsed = JSON.parse(stdout) as {
      AccessKeyId?: string;
      SecretAccessKey?: string;
      SessionToken?: string;
    };
    if (!parsed.AccessKeyId || !parsed.SecretAccessKey) return;
    process.env.AWS_ACCESS_KEY_ID = parsed.AccessKeyId;
    process.env.AWS_SECRET_ACCESS_KEY = parsed.SecretAccessKey;
    if (parsed.SessionToken)
      process.env.AWS_SESSION_TOKEN = parsed.SessionToken;
  } catch {
    /* The default SDK chain still applies. */
  }
}
