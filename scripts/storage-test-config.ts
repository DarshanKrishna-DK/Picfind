export function developmentStorageConfig(
  env: Record<string, string | undefined>,
) {
  const endpoint = env.APPWRITE_ENDPOINT?.replace(/\/$/, '');
  const projectId = env.APPWRITE_PROJECT_ID;
  const apiKey = env.APPWRITE_API_KEY;
  if (
    endpoint !== 'https://fra.cloud.appwrite.io/v1' ||
    projectId !== 'picfind-development' ||
    !apiKey?.trim()
  )
    throw new Error(
      'Storage diagnostics are restricted to PicFind Development in Frankfurt with a configured server key.',
    );
  return { endpoint, projectId, apiKey };
}
