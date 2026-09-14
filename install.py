"""Install the packaged plugin into this user's personal Codex marketplace.

Mirrors the flow used by the sibling `codex-turn-meter-package` repo:

  1. scaffold a personal-marketplace entry (via the official plugin-creator helper)
  2. copy `plugins/codex-human-input-mcp` into `~/plugins/codex-human-input-mcp`
  3. rewrite the bare `node` in `.mcp.json` to this machine's absolute Node path
  4. bump the cachebuster, validate, and register the plugin

Python 3.10+ is required because it drives the plugin-creator helper scripts.
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

PLUGIN_NAME = 'codex-human-input-mcp'
SERVER_KEY = 'human_input'


def main():
    if sys.version_info < (3, 10):
        raise SystemExit('Python 3.10+ is required.')

    home = Path.home()
    source = Path(__file__).resolve().parent / 'plugins' / PLUGIN_NAME
    if not source.is_dir():
        raise SystemExit(f'Plugin source not found: {source}')

    node = shutil.which('node')
    if not node:
        raise SystemExit(
            'Node.js was not found on PATH. Install Node.js 20+ and re-run, '
            'or edit ~/plugins/%s/.mcp.json manually.' % PLUGIN_NAME
        )

    target = home / 'plugins' / PLUGIN_NAME
    helpers = home / '.codex/skills/.system/plugin-creator/scripts'
    create = helpers / 'create_basic_plugin.py'
    if not create.is_file():
        raise SystemExit('The Codex plugin-creator skill is required for personal marketplace registration.')

    bundled = Path(os.environ.get('LOCALAPPDATA', str(home / 'AppData/Local'))) / 'OpenAI/Codex/bin'
    candidates = (
        [p for p in bundled.glob('*/codex.exe') if p.is_file() and p.stat().st_size > 1024 * 1024]
        if os.name == 'nt'
        else []
    )
    codex = str(max(candidates, key=lambda p: p.stat().st_mtime)) if candidates else (
        shutil.which('codex.cmd') if os.name == 'nt' else shutil.which('codex')
    )
    if not codex:
        raise SystemExit('Codex CLI not found in PATH.')

    marketplace = home / '.agents/plugins/marketplace.json'
    existing = marketplace.exists()
    if existing:
        market = subprocess.check_output(
            [sys.executable, str(helpers / 'read_marketplace_name.py')], text=True
        ).strip()
    else:
        market = 'personal'

    expected_source = {'source': 'local', 'path': f'./plugins/{PLUGIN_NAME}'}

    # A second installation is explicit and only updates this plugin's own tree.
    if target.exists():
        manifest = json.loads((target / '.codex-plugin/plugin.json').read_text(encoding='utf-8'))
        if manifest.get('name') != PLUGIN_NAME:
            raise SystemExit('Target is not the expected plugin.')
        entries = json.loads(marketplace.read_text(encoding='utf-8'))['plugins'] if existing else []
        if not any(
            p.get('name') == PLUGIN_NAME and p.get('source') == expected_source for p in entries
        ):
            raise SystemExit('Existing target has no matching personal marketplace entry.')
    else:
        subprocess.run(
            [sys.executable, str(create), PLUGIN_NAME, '--with-skills', '--with-mcp', '--with-marketplace'],
            check=True,
        )

    shutil.copytree(
        source,
        target,
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns('__pycache__', '*.pyc'),
    )

    # Resolve `node` for this machine so the plugin does not depend on the
    # spawned process' PATH.
    config_path = target / '.mcp.json'
    config = json.loads(config_path.read_text(encoding='utf-8'))
    if SERVER_KEY not in config.get('mcpServers', {}):
        raise SystemExit(f'.mcp.json is missing the `{SERVER_KEY}` server entry.')
    config['mcpServers'][SERVER_KEY]['command'] = node
    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    subprocess.run([sys.executable, str(helpers / 'update_plugin_cachebuster.py'), str(target)], check=True)
    subprocess.run([sys.executable, str(helpers / 'validate_plugin.py'), str(target)], check=True)
    subprocess.run([codex, 'plugin', 'add', f'{PLUGIN_NAME}@{market}'], check=True)

    print(f'Installed with node = {node}')
    print('Open a new task and try: 遇到需要我决定的地方就弹卡片问我')


if __name__ == '__main__':
    main()
