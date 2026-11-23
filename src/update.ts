import { SERVER_VERSION } from './config.js';
import { z } from 'zod';

const repository = 'https://github.com/EliotOK/JustAskMe';
const releaseApi = 'https://api.github.com/repos/EliotOK/JustAskMe/releases/latest';
const stableRelease = z.object({
  tag_name: z.string(),
  draft: z.literal(false).optional(),
  prerelease: z.literal(false).optional()
});

function stableVersion(tag: string): number[] {
  if (!/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) {
    throw new Error('Expected a stable major.minor.patch release tag.');
  }
  const parts = tag.replace(/^v/, '').split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('Invalid release number.');
  return parts;
}

export async function checkForUpdates(request: typeof fetch = fetch) {
  const current = { installed_version: SERVER_VERSION };
  try {
    const response = await request(releaseApi, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'JustAskMe/' + SERVER_VERSION },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error('GitHub returned HTTP ' + response.status);
    const release = stableRelease.safeParse(await response.json());
    if (!release.success) {
      throw new Error('GitHub did not return a stable release.');
    }
    const tag = release.data.tag_name;
    const remote = stableVersion(tag);
    const local = stableVersion(SERVER_VERSION);
    const difference = remote.map((part, index) => part - local[index]!).find(delta => delta !== 0) ?? 0;
    const status = difference > 0 ? 'update_available' : difference < 0 ? 'installed_ahead' : 'up_to_date';
    return { ...current, status, latest_version: remote.join('.'), release_url: repository + '/releases/tag/' + tag };
  } catch (error) {
    return { ...current, status: 'check_failed', release_url: repository + '/releases/latest',
      error: error instanceof Error ? error.message : String(error) };
  }
}
