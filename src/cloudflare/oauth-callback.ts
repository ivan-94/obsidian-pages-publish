export function parseCloudflareOAuthCallback(
  params: Readonly<Record<string, string>>,
): { state: string; code: string } {
  const state = params.state;
  const code = params.code;
  if (
    params.error !== undefined ||
    typeof state !== 'string' ||
    state.length === 0 ||
    typeof code !== 'string' ||
    code.length === 0
  ) {
    throw new Error('Cloudflare authorization did not return a valid callback.');
  }
  return { state, code };
}
