import assert from 'node:assert/strict';
import { it } from 'node:test';
import { SERVER_VERSION } from '../src/config.js';
import { checkForUpdates } from '../src/update.js';

it('compares stable release numbers and links to the checked tag', async () => {
  for (const [tag, expected] of [
    ['v' + SERVER_VERSION, 'up_to_date'], ['v0.10.0', 'update_available'], ['v0.2.0', 'installed_ahead']
  ] as const) {
    const result = await checkForUpdates(async () => Response.json({ tag_name: tag }));
    assert.equal(result.status, expected);
    assert.equal(result.installed_version, SERVER_VERSION);
    assert.equal(result.release_url, 'https://github.com/EliotOK/JustAskMe/releases/tag/' + tag);
  }
});

it('reports lookup failures separately from the installed version being current', async () => {
  for (const response of [
    new Response(null, { status: 403 }), Response.json({ tag_name: 'v1.0.0-rc.1' }),
    Response.json({ tag_name: 'v1.0.0', prerelease: true }), Response.json({})
  ]) {
    const result = await checkForUpdates(async () => response);
    assert.equal(result.status, 'check_failed');
  }
});
