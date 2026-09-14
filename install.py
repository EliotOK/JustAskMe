"""Install the packaged plugin into this user's personal Codex marketplace.

Mirrors the flow used by the sibling `codex-turn-meter-package` repo:

  1. scaffold a personal-marketplace entry (via the official plugin-creator helper)
  2. copy `plugins/just-ask-me` into `~/plugins/just-ask-me`
  3. rewrite the bare `node` in `.mcp.json` to this machine's absolute Node path
  4. bump the cachebuster, validate, and register the plugin
  5. migrate away conflicting manual registrations (with `--migrate`)

The plugin declares the same MCP server key (`human_input`) and the same skill
name (`discuss-with-me`, legacy `discussion-mode`) that a hand-written `config.toml` / `~/.codex/skills`
setup uses. Running both registrations at once means duplicated `ask_*` tools,
so the installer refuses to install over a live manual server entry unless
`--migrate` is passed; migration comments the TOML section out (never deletes)
and archives the manual skill directory (never deletes).

Python 3.10+ is required because it drives the plugin-creator helper scripts.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

PLUGIN_NAME = 'just-ask-me'
LEGACY_PLUGIN_NAME = 'codex-human-input-mcp'  # pre-0.2.0 installs
SERVER_KEY = 'human_input'
SKILL_NAME = 'discuss-with-me'
LEGACY_SKILL_NAME = 'discussion-mode'  # pre-0.1.1 plugin/manual copies

# A TOML table header that belongs to our server: the server table itself and
# any of its sub-tables (`[mcp_servers.human_input.env]`, ...).
OURS_HEADER = re.compile(r'^\[mcp_servers\.%s(?:\.[^\]]+)?\]' % re.escape(SERVER_KEY))
ANY_HEADER = re.compile(r'^\[')
MIGRATION_BEGIN = '# >>> codex-human-input-mcp migration (%s): manual server disabled, plugin replaces it'
MIGRATION_END = '# <<< codex-human-input-mcp migration'


def find_server_section(lines):
    """Line indices covered by `[mcp_servers.human_input*]` tables, or None."""
    span = None
    bounded = False  # an unrelated header was found after the section
    for index, line in enumerate(lines):
        if span is None:
            if OURS_HEADER.match(line):
                span = [index, index]
        elif ANY_HEADER.match(line) and not OURS_HEADER.match(line):
            span[1] = index - 1
            bounded = True
            break
    if span is None:
        return None
    if not bounded:
        # No unrelated header followed: the section runs to EOF. (Sub-tables
        # like `.env` match OURS_HEADER, so they never bound the span.)
        span[1] = len(lines) - 1
    # Trim trailing blank lines so they stay outside the commented block.
    end = span[1]
    while end > span[0] and lines[end].strip() == '':
        end -= 1
    return [span[0], end]


def comment_out_server_section(config_path):
    lines = config_path.read_text(encoding='utf-8').splitlines()
    if any(MIGRATION_BEGIN.split('(')[0] in line for line in lines):
        print(f'  {config_path}: already migrated, leaving as is')
        return
    span = find_server_section(lines)
    if span is None:
        return
    start, end = span
    block = [MIGRATION_BEGIN % time.strftime('%Y-%m-%d')]
    block += ['# ' + line for line in lines[start:end + 1]]
    block.append(MIGRATION_END)
    lines[start:end + 1] = block
    config_path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'  {config_path}: commented out [mcp_servers.{SERVER_KEY}] (lines {start + 1}-{end + 1}); '
          'delete the block to roll back')


def migrate_legacy_plugin(home, codex):
    """Best-effort removal of pre-0.2.0 installs registered under the old name."""
    legacy_target = home / 'plugins' / LEGACY_PLUGIN_NAME
    marketplace = home / '.agents/plugins/marketplace.json'
    entry_exists = False
    if marketplace.is_file():
        try:
            entries = json.loads(marketplace.read_text(encoding='utf-8')).get('plugins', [])
            entry_exists = any(p.get('name') == LEGACY_PLUGIN_NAME for p in entries)
        except (json.JSONDecodeError, OSError):
            pass
    if not legacy_target.exists() and not entry_exists:
        return
    print(f'Migrating legacy {LEGACY_PLUGIN_NAME} install:')
    subprocess.run(
        [codex, 'plugin', 'remove', f'{LEGACY_PLUGIN_NAME}@personal'],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if legacy_target.exists():
        shutil.rmtree(legacy_target)
        print(f'  removed {legacy_target}')
    if entry_exists:
        data = json.loads(marketplace.read_text(encoding='utf-8'))
        data['plugins'] = [p for p in data.get('plugins', []) if p.get('name') != LEGACY_PLUGIN_NAME]
        marketplace.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(f'  dropped {LEGACY_PLUGIN_NAME} from {marketplace}')


def check_manual_server(home, migrate):
    """Refuse to install over a live manual `human_input` server registration."""
    config_path = home / '.codex' / 'config.toml'
    if not config_path.is_file():
        return
    span = find_server_section(config_path.read_text(encoding='utf-8').splitlines())
    if span is None:
        return
    if not migrate:
        raise SystemExit(
            f'{config_path} already registers an [mcp_servers.{SERVER_KEY}] server '
            f'(line {span[0] + 1}). Installing the plugin on top would register the same '
            'server twice and duplicate every ask_* tool.\n'
            'Remove that section yourself and re-run, or re-run with --migrate to have '
            'the section commented out automatically (nothing is deleted; undo is trivial).'
        )


def archive_manual_skill(home, migrate):
    """Warn about (and optionally archive) a manually installed same-name skill."""
    for name in (SKILL_NAME, LEGACY_SKILL_NAME):
        manual = home / '.codex' / 'skills' / name
        if not manual.is_dir():
            continue
        if not migrate:
            print(
                f'NOTE: {manual} also declares the `{name}` skill. The manual copy and the '
                'plugin copy will shadow each other; the plugin bundles a newer version '
                '(question-timing rules, session-persistent activation).\n'
                'Re-run with --migrate to archive the manual copy automatically (renamed, never deleted).'
            )
            return
        stamp = time.strftime('%Y%m%d-%H%M%S')
        backup = manual.with_name(f'{name}.bak-{stamp}')
        manual.rename(backup)
        print(f'  archived {manual} -> {backup}')


def remove_stale_target_skill(target):
    """Delete a pre-0.1.1 `skills/discussion-mode` copy left in the plugin target.

    The target tree is this installer's own output, so removing the old-named
    skill directory prevents the renamed plugin from shipping both copies.
    """
    stale = target / 'skills' / LEGACY_SKILL_NAME
    if stale.is_dir():
        shutil.rmtree(stale)
        print(f'  removed stale {stale} (superseded by skills/{SKILL_NAME})')


def main():
    if sys.version_info < (3, 10):
        raise SystemExit('Python 3.10+ is required.')

    migrate = '--migrate' in sys.argv[1:]
    home = Path.home()
    source = Path(__file__).resolve().parent / 'plugins' / PLUGIN_NAME
    if not source.is_dir():
        raise SystemExit(f'Plugin source not found: {source}')

    check_manual_server(home, migrate)

    migrate_legacy_plugin(home, codex)

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

    remove_stale_target_skill(target)

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

    # Migrate only after the plugin is registered, so a failed install never
    # leaves the user with neither registration working.
    print('Migrating conflicting manual registrations:')
    config_path = home / '.codex' / 'config.toml'
    if config_path.is_file():
        comment_out_server_section(config_path)
    archive_manual_skill(home, migrate)

    print(f'Installed with node = {node}')
    print('Verify in a NEW Codex task:')
    print('  1. ask human_input_status — it must list exactly one set of ask_* tools.')
    print('  2. Run $discuss-with-me: it should mention 提问时机 (the plugin skill version).')
    print('Then try: 遇到需要我决定的地方就弹卡片问我')


if __name__ == '__main__':
    main()
