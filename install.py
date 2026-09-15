"""Install JustAskMe with staged files and recoverable configuration backups."""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

PLUGIN_NAME = 'just-ask-me'
LEGACY_PLUGIN_NAME = 'codex-human-input-mcp'
SERVER_KEY = 'human_input'
SKILL_NAMES = ('discuss-with-me', 'discussion-mode')


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp-' + uuid.uuid4().hex)
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def server_lines(text):
    """Find server tables, including quoted keys and separated subtables."""
    key = r'(?:human_input|"human_input"|\'human_input\')'
    header = re.compile(r'^\s*\[\s*(?:mcp_servers|"mcp_servers"|\'mcp_servers\')\s*\.\s*' + key + r'\s*(?:\.|\])')
    if chr(34) * 3 in text or chr(39) * 3 in text:
        try:
            import tomllib
        except ImportError:
            raise ValueError('Python 3.11+ is required to inspect multiline TOML safely.')
        parsed = tomllib.loads(text)
        if SERVER_KEY not in parsed.get('mcp_servers', {}):
            return []
        raise ValueError('Multiline TOML strings require manual migration; configuration was not modified.')
    active = False
    indices = []
    for i, line in enumerate(text.splitlines()):
        if re.match(r'^\s*\[', line):
            active = bool(header.match(line))
        if active:
            indices.append(i)
    return indices


def disable_manual(text):
    indices = set(server_lines(text))
    return '\n'.join('# ' + line if i in indices else line
                     for i, line in enumerate(text.splitlines())) + '\n'


def discover_skills(home, codex_home):
    found = []
    for root in dict.fromkeys((codex_home / 'skills', home / '.agents/skills')):
        if not root.is_dir():
            continue
        for path in root.iterdir():
            if not any(path.name == n or path.name.startswith(n + '.bak-') for n in SKILL_NAMES):
                continue
            skill = path / 'SKILL.md'
            if not skill.is_file():
                continue
            text = skill.read_text(encoding='utf-8')
            if not re.search(r'^name:\s*[\"\']?(discuss-with-me|discussion-mode)[\"\']?\s*$', text, re.M) or 'human_input' not in text:
                raise ValueError(f'Unrecognized conflicting skill: {path}. Resolve it manually.')
            if path.is_symlink() or path.resolve().parent != root.resolve():
                raise ValueError(f'Refusing to migrate linked skill: {path}')
            found.append(path)
    return found


def find_codex(home):
    for name in ('codex.exe', 'codex.cmd', 'codex') if os.name == 'nt' else ('codex',):
        executable = shutil.which(name)
        if executable:
            return executable
    bundled = Path(os.environ.get('LOCALAPPDATA', str(home / 'AppData/Local'))) / 'OpenAI/Codex/bin'
    candidates = [p for p in bundled.glob('*/codex.exe') if p.is_file() and p.stat().st_size > 1024 * 1024]
    if candidates:
        return str(max(candidates, key=lambda p: p.stat().st_mtime))
    raise ValueError('Codex CLI not found. Install Codex and put its executable on PATH.')


def install(home, codex_home, source, node, codex, migrate=False, run=subprocess.run):
    home, codex_home, source = home.resolve(), codex_home.resolve(), source.resolve()
    target = home / 'plugins' / PLUGIN_NAME
    marketplace = home / '.agents/plugins/marketplace.json'
    config = codex_home / 'config.toml'
    original_market = marketplace.read_bytes() if marketplace.exists() else None
    original_config = config.read_bytes() if config.exists() else None
    market = json.loads(original_market) if original_market else {
        'name': 'personal', 'interface': {'displayName': 'Personal'}, 'plugins': []}
    if not re.fullmatch(r'[A-Za-z0-9_-]+', market.get('name', '')) or not isinstance(market.get('plugins'), list):
        raise ValueError('Invalid personal marketplace metadata.')
    entries = market['plugins']
    expected = {'source': 'local', 'path': './plugins/' + PLUGIN_NAME}
    current = [e for e in entries if e.get('name') == PLUGIN_NAME]
    legacy = [e for e in entries if e.get('name') == LEGACY_PLUGIN_NAME]
    if legacy and legacy[0].get('source') != {'source': 'local', 'path': './plugins/' + LEGACY_PLUGIN_NAME}:
        raise ValueError('Legacy plugin points to another source; resolve it manually.')
    if len(current) > 1 or len(legacy) > 1:
        raise ValueError('Duplicate plugin entries; resolve them before installing.')
    if current and current[0].get('source') != expected:
        raise ValueError('Existing JustAskMe entry points to another source.')
    if target.exists():
        if target.is_symlink() or target.resolve().parent != (home / 'plugins').resolve():
            raise ValueError('Refusing to replace a linked plugin directory.')
        manifest = json.loads((target / '.codex-plugin/plugin.json').read_text(encoding='utf-8'))
        if manifest.get('name') != PLUGIN_NAME or not current:
            raise ValueError('Existing target is not a registered JustAskMe installation.')
    text = original_config.decode('utf-8-sig') if original_config else ''
    skills = discover_skills(home, codex_home)
    if (legacy or server_lines(text) or skills) and not migrate:
        raise ValueError('Conflicting installation found. Re-run with --migrate to back it up and migrate it.')
    env = dict(os.environ, CODEX_HOME=str(codex_home))
    version = run([node, '--version'], check=True, capture_output=True, text=True).stdout.strip()
    match = re.fullmatch(r'v(\d+)\.(\d+)\.(\d+)', version)
    if not match or tuple(map(int, match.groups())) < (20, 11, 0):
        raise ValueError('Node.js >=20.11.0 is required.')
    run([codex, 'plugin', 'add', '--help'], check=True, capture_output=True, env=env)
    backup_root = codex_home / 'just-ask-me-backups'
    backup_root.mkdir(parents=True, exist_ok=True)
    backup = Path(tempfile.mkdtemp(prefix='install-', dir=backup_root))
    for name, content in (('marketplace.json', original_market), ('config.toml', original_config)):
        if content is not None:
            (backup / name).write_bytes(content)
    write_json(backup / 'restore.json', {'target': str(target), 'marketplace': str(marketplace),
               'config': str(config), 'had_marketplace': original_market is not None,
               'had_config': original_config is not None, 'skills': [str(p) for p in skills]})
    stage = backup / PLUGIN_NAME
    shutil.copytree(source, stage)
    manifest_path = stage / '.codex-plugin/plugin.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if manifest.get('name') != PLUGIN_NAME:
        raise ValueError('Unexpected packaged plugin name.')
    manifest['version'] = manifest['version'].split('+')[0] + '+codex.' + uuid.uuid4().hex
    write_json(manifest_path, manifest)
    mcp = json.loads((stage / '.mcp.json').read_text(encoding='utf-8'))
    mcp['mcpServers'][SERVER_KEY]['command'] = node
    write_json(stage / '.mcp.json', mcp)
    if not (stage / 'skills/discuss-with-me/SKILL.md').is_file():
        raise ValueError('Packaged skill is missing.')
    run([node, '--check', str(stage / 'server/index.mjs')], check=True, capture_output=True)
    if not current:
        entries.append({'name': PLUGIN_NAME, 'source': expected,
                        'policy': {'installation': 'AVAILABLE', 'authentication': 'ON_INSTALL'},
                        'category': 'Productivity'})
    moved = []
    swapped = False
    registration_attempted = False
    legacy_attempted = False
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            target.rename(backup / 'previous-plugin')
        stage.rename(target)
        swapped = True
        write_json(marketplace, market)
        registration_attempted = True
        run([codex, 'plugin', 'add', f'{PLUGIN_NAME}@{market["name"]}'], check=True, env=env)
        if legacy:
            legacy_attempted = True
            run([codex, 'plugin', 'remove', f'{LEGACY_PLUGIN_NAME}@{market["name"]}'], check=True, env=env)
            market['plugins'] = [e for e in entries if e.get('name') != LEGACY_PLUGIN_NAME]
            write_json(marketplace, market)
        if server_lines(text):
            # Read after registration to preserve changes made by the CLI.
            config.write_text(disable_manual(config.read_text(encoding='utf-8-sig')), encoding='utf-8')
        for i, path in enumerate(skills):
            destination = backup / f'skill-{i}'
            path.rename(destination)
            moved.append((path, destination))
    except BaseException:
        errors = []
        def recover(action):
            try:
                action()
            except Exception as error:
                errors.append(str(error))
        if registration_attempted:
            recover(lambda: run([codex, 'plugin', 'remove', f'{PLUGIN_NAME}@{market["name"]}'], check=True, env=env))
        for path, destination in reversed(moved):
            recover(lambda p=path, d=destination: d.rename(p))
        if swapped:
            recover(lambda: target.rename(backup / 'failed-plugin'))
        if (backup / 'previous-plugin').exists():
            recover(lambda: (backup / 'previous-plugin').rename(target))
        def restore_file(path, content):
            if content is None:
                path.unlink(missing_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
        recover(lambda: restore_file(marketplace, original_market))
        if current:
            recover(lambda: run([codex, 'plugin', 'add', f'{PLUGIN_NAME}@{market["name"]}'], check=True, env=env))
        if legacy_attempted:
            recover(lambda: run([codex, 'plugin', 'add', f'{LEGACY_PLUGIN_NAME}@{market["name"]}'], check=True, env=env))
        recover(lambda: restore_file(config, original_config))
        print(f'Installation failed. Recovery backups: {backup}', file=sys.stderr)
        if errors:
            print('Recovery needs attention: ' + '; '.join(errors), file=sys.stderr)
        raise
    print(f'Installed JustAskMe. Recovery backups: {backup}')
    print('Open a NEW Codex task and run human_input_status, then try $discuss-with-me.')
    return backup


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--migrate', action='store_true')
    args = parser.parse_args()
    home = Path.home()
    codex_home = Path(os.environ.get('CODEX_HOME', str(home / '.codex'))).expanduser()
    node = shutil.which('node')
    if not node:
        raise ValueError('Node.js >=20.11.0 must be on PATH.')
    install(home, codex_home, Path(__file__).resolve().parent / 'plugins' / PLUGIN_NAME,
            node, find_codex(home), args.migrate)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from error
