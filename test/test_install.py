import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('installer', Path(__file__).parents[1] / 'install.py')
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)
SOURCE = Path(__file__).parents[1] / 'plugins/just-ask-me'


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.codex_home = self.home / 'custom-codex'
        self.calls = []
        self.fail = None

    def run_command(self, args, **kwargs):
        self.calls.append(args)
        if self.fail and self.fail(args):
            raise subprocess.CalledProcessError(1, args)
        return subprocess.CompletedProcess(args, 0, stdout='v24.15.0\n', stderr='')

    def install(self, migrate=False):
        return installer.install(self.home, self.codex_home, SOURCE, 'node', 'codex', migrate, self.run_command)

    def seed_market(self):
        path = self.home / '.agents/plugins/marketplace.json'
        installer.write_json(path, {'name': 'personal', 'interface': {'displayName': 'Mine'}, 'plugins': [
            {'name': 'another-plugin', 'source': {'source': 'local', 'path': './plugins/another-plugin'}},
            {'name': installer.LEGACY_PLUGIN_NAME, 'source': {'source': 'local', 'path': './plugins/' + installer.LEGACY_PLUGIN_NAME}}
        ]})
        old = self.home / 'plugins' / installer.LEGACY_PLUGIN_NAME
        old.mkdir(parents=True)
        (old / 'keep.txt').write_text('original')
        return path, old

    def test_clean_install_needs_no_external_helpers(self):
        self.install()
        self.assertTrue((self.home / 'plugins/just-ask-me/server/index.mjs').is_file())
        self.assertFalse((self.home / '.codex').exists())
        self.assertTrue((self.codex_home / 'just-ask-me-backups').is_dir())

    def test_repeat_install_preserves_unrelated_metadata(self):
        self.install()
        path = self.home / '.agents/plugins/marketplace.json'
        data = json.loads(path.read_text()); data['custom'] = 'keep'
        installer.write_json(path, data)
        backup = self.install()
        self.assertTrue((backup / 'previous-plugin').is_dir())
        data = json.loads(path.read_text())
        self.assertEqual(data['custom'], 'keep')
        self.assertEqual(len(data['plugins']), 1)

    def test_migration_is_explicit(self):
        path, old = self.seed_market()
        before = path.read_bytes()
        with self.assertRaises(ValueError): self.install()
        self.assertEqual(path.read_bytes(), before)
        self.assertTrue(old.is_dir())
        self.assertEqual(self.calls, [])

    def test_failed_registration_keeps_legacy_and_config(self):
        path, old = self.seed_market()
        before = path.read_bytes()
        config = self.codex_home / 'config.toml'
        config.parent.mkdir(parents=True)
        config.write_bytes(b'[mcp_servers.human_input]\r\ncommand="old"\r\n')
        original = config.read_bytes()
        self.fail = lambda a: a[1:3] == ['plugin', 'add'] and a[-1] == 'just-ask-me@personal'
        with self.assertRaises(subprocess.CalledProcessError): self.install(True)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(config.read_bytes(), original)
        self.assertEqual((old / 'keep.txt').read_text(), 'original')
        self.assertFalse(any(a[-1] == 'codex-human-input-mcp@personal' for a in self.calls))

    def test_failed_legacy_removal_restores_new_install(self):
        path, old = self.seed_market()
        before = path.read_bytes()
        self.fail = lambda a: a[1:] == ['plugin', 'remove', 'codex-human-input-mcp@personal']
        with self.assertRaises(subprocess.CalledProcessError): self.install(True)
        self.assertEqual(path.read_bytes(), before)
        self.assertTrue(old.is_dir())
        self.assertFalse((self.home / 'plugins/just-ask-me').exists())
        self.assertIn(['codex', 'plugin', 'add', 'codex-human-input-mcp@personal'], self.calls)

    def test_skills_are_archived_outside_both_scan_roots(self):
        roots = [self.codex_home / 'skills', self.home / '.agents/skills']
        for root in roots:
            skill = root / 'discussion-mode.bak-old'
            skill.mkdir(parents=True)
            (skill / 'SKILL.md').write_text('---\nname: discussion-mode\n---\nhuman_input')
        backup = self.install(True)
        self.assertTrue((backup / 'skill-0/SKILL.md').is_file())
        self.assertTrue((backup / 'skill-1/SKILL.md').is_file())
        for root in roots: self.assertEqual(list(root.rglob('SKILL.md')), [])

    def test_separated_and_quoted_server_tables(self):
        text = '[mcp_servers."human_input"]\ncommand="old"\n[unrelated]\na=1\n[mcp_servers.human_input.env]\nA="B"\n'
        result = installer.disable_manual(text)
        self.assertIn('[unrelated]\na=1', result)
        self.assertIn('# [mcp_servers.human_input.env]\n# A="B"', result)

    def test_old_node_is_rejected_before_writes(self):
        def old_node(args, **kwargs):
            return subprocess.CompletedProcess(args, 0, stdout='v18.20.0')
        with self.assertRaises(ValueError):
            installer.install(self.home, self.codex_home, SOURCE, 'node', 'codex', run=old_node)
        self.assertFalse((self.home / 'plugins').exists())


if __name__ == '__main__':
    unittest.main()
