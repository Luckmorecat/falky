"""Release planning/artifact CLI against real source history; no host access."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('release', ROOT / 'release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / 'deploy').mkdir()
        for name in (*release.FILES, 'ci-plan.py'):
            shutil.copyfile(ROOT / name, self.root / 'deploy' / name)
        self.git('init', '-q', '-b', 'master')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'user.name', 'Test')
        self.git('add', 'deploy')
        self.change('server/main.go', 'initial')
        self.environment = dict(os.environ, GITHUB_EVENT_NAME='push',
                                GITHUB_REF='refs/heads/master', GITHUB_REF_TYPE='branch',
                                GITHUB_OUTPUT=str(self.root / 'output'))
        self.snapshot = {'version': 1, 'token': 'a' * 64, 'release': None,
                         'ancestry': None, 'pending': None, 'legacy': False}

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root, stderr=subprocess.PIPE).decode().strip()

    def change(self, path, value):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(value)
        self.git('add', path)
        self.git('commit', '-qm', 'fixture change')

    def command(self, *args, succeeds=True, environment=None):
        result = subprocess.run([sys.executable, str(self.root / 'deploy/ci-plan.py'), *args],
                                cwd=self.root, env=environment or self.environment,
                                capture_output=True, text=True)
        if succeeds:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
        return result

    def plan(self, succeeds=True):
        (self.root / 'baseline.json').write_text(json.dumps(self.snapshot))
        (self.root / 'output').write_text('')
        result = self.command('plan', str(self.root / 'baseline.json'), succeeds=succeeds)
        if not succeeds:
            return result
        output = dict(line.split('=', 1) for line in (self.root / 'output').read_text().splitlines())
        return output, release.decode(output['plan'])

    def manifest(self, source):
        return {'version': 1, **source, 'package': {'version': 1, 'sha256': 'b' * 64, 'size': 10240},
                'images': {'server': release.REPOSITORIES['server'] + '@sha256:' + 'c' * 64,
                           'web': release.REPOSITORIES['web'] + '@sha256:' + 'd' * 64,
                           'livekit': release.LIVEKIT}}

    def test_both_images_follow_last_successful_inputs_across_docs_and_failed_runs(self):
        output, planned = self.plan()
        self.assertEqual((output['server'], output['web'], planned['mode']), ('true', 'true', 'release'))
        self.snapshot['release'] = self.manifest(planned['source'])
        self.snapshot['ancestry'] = planned['source']['revision']
        self.change('docs/runbook.md', 'only docs')
        output, planned = self.plan()
        self.assertEqual((output['server'], output['web'], planned['mode']), ('false', 'false', 'skip'))
        self.change('web/main.ts', 'runtime change')
        output, _ = self.plan()
        self.assertEqual((output['server'], output['web']), ('true', 'true'))
        # No successful release update: a later docs commit must still deploy.
        self.change('docs/runbook.md', 'more docs after failed/coalesced build')
        output, _ = self.plan()
        self.assertEqual((output['server'], output['web']), ('true', 'true'))

    def test_exact_pending_attempt_retries_without_builds_and_other_targets_refuse(self):
        _, planned = self.plan()
        request = {'version': 1, 'baseline': 'e' * 64, 'release': self.manifest(planned['source'])}
        self.snapshot['pending'] = {'request': request, 'stage': 'activated', 'backup': 'backups/original', 'recovery': False}
        output, retry = self.plan()
        self.assertEqual((output['server'], output['web'], retry['mode']), ('false', 'false', 'retry'))
        self.assertEqual(retry['request'], request)
        for field, value in [('revision', '1' * 40), ('ref', 'refs/tags/v1.2.3'), ('environment', 'production')]:
            with self.subTest(field=field):
                different = json.loads(json.dumps(request))
                different['release'][field] = value
                if field in ('ref', 'environment'):
                    different['release'].update(environment='production', ref='refs/tags/v1.2.3')
                self.snapshot['pending']['request'] = different
                self.assertIn('operator', self.plan(succeeds=False).stderr.lower())
        self.snapshot['pending']['request'] = request
        self.environment.update(GITHUB_REF='refs/tags/v1.2.3', GITHUB_REF_TYPE='tag')
        self.assertIn('operator', self.plan(succeeds=False).stderr.lower())

    def test_ancestry_uses_preserved_high_water_even_after_recovery(self):
        _, initial = self.plan()
        old = initial['source']['revision']
        self.snapshot['release'] = self.manifest(initial['source'])
        self.change('server/main.go', 'newer successful deployment')
        self.snapshot['ancestry'] = self.git('rev-parse', 'HEAD')
        self.plan()
        self.git('checkout', '-q', old)
        self.assertIn('ancestry', self.plan(succeeds=False).stderr.lower())
        self.snapshot['ancestry'] = 'f' * 40
        self.assertIn('ancestry', self.plan(succeeds=False).stderr.lower())

    def resolve_environment(self, planned, **overrides):
        return dict(self.environment, RELEASE_PLAN=release.encode(planned),
                    SERVER_RESULT='success', WEB_RESULT='success',
                    SERVER_DIGEST='sha256:' + 'c' * 64, WEB_DIGEST='sha256:' + 'd' * 64,
                    **overrides)

    def test_resolver_packages_source_and_requires_both_actual_build_results(self):
        _, planned = self.plan()
        directory = self.root / 'artifact'
        environment = self.resolve_environment(planned)
        result = self.command('resolve', str(directory), environment=environment)
        command, encoded = result.stdout.strip().split(' ', 1)
        self.assertEqual(command, 'deploy-release')
        request = release.decode(encoded)
        release.valid_request(request)
        manifest = json.loads((directory / 'manifest.json').read_text())
        self.assertEqual(request, {'version': 1, 'baseline': self.snapshot['token'], 'release': manifest})
        self.assertEqual(manifest['revision'], self.git('rev-parse', 'HEAD'))
        self.assertEqual(manifest['images']['server'], release.REPOSITORIES['server'] + '@sha256:' + 'c' * 64)
        release.unpack((directory / 'runtime.tar').read_bytes(), manifest['package'])
        for key in ('SERVER_RESULT', 'WEB_RESULT'):
            for result in ('skipped', 'failure', 'cancelled'):
                with self.subTest(key=key, result=result):
                    failed = dict(environment, **{key: result})
                    self.command('resolve', str(self.root / 'must-not-exist'), succeeds=False, environment=failed)
                    self.assertFalse((self.root / 'must-not-exist').exists())
        self.command('resolve', str(self.root / 'bad-digest'), succeeds=False,
                     environment=dict(environment, WEB_DIGEST='latest'))

    def test_retry_resolver_uses_original_request_and_never_creates_archive(self):
        _, planned = self.plan()
        request = {'version': 1, 'baseline': 'e' * 64, 'release': self.manifest(planned['source'])}
        self.snapshot['pending'] = {'request': request, 'stage': 'prepared', 'backup': 'backups/original', 'recovery': False}
        _, planned = self.plan()
        environment = self.resolve_environment(planned)
        environment.update(SERVER_RESULT='skipped', WEB_RESULT='skipped', SERVER_DIGEST='', WEB_DIGEST='')
        directory = self.root / 'retry-artifact'
        result = self.command('resolve', str(directory), environment=environment)
        self.assertEqual(result.stdout.strip(), 'retry-release ' + release.encode(request))
        self.assertFalse(directory.exists())
        environment['SERVER_RESULT'] = 'success'
        self.command('resolve', str(directory), succeeds=False, environment=environment)


    def test_prepare_needs_no_host_snapshot_and_emits_only_exact_artifacts(self):
        self.environment.update(GITHUB_EVENT_NAME='workflow_dispatch', PREPARE_ENVIRONMENT='development')
        self.command('prepare')
        output = dict(line.split('=', 1) for line in (self.root / 'output').read_text().splitlines())
        planned = release.decode(output['plan'])
        self.assertEqual((output['server'], output['web'], planned['mode']), ('true', 'true', 'prepare'))
        directory = self.root / 'prepared'
        result = self.command('resolve', str(directory), environment=self.resolve_environment(planned))
        self.assertEqual(result.stdout.strip(), '')
        self.assertEqual(sorted(item.name for item in directory.iterdir()), ['manifest.json', 'runtime.tar'])
        manifest = json.loads((directory / 'manifest.json').read_text())
        self.assertEqual(manifest['environment'], 'development')
        release.unpack((directory / 'runtime.tar').read_bytes(), manifest['package'])
        self.environment['PREPARE_ENVIRONMENT'] = 'production'
        self.command('prepare', succeeds=False)
        self.environment.update(GITHUB_REF='refs/heads/codex/feature', PREPARE_ENVIRONMENT='development')
        self.command('prepare', succeeds=False)
        self.environment.update(GITHUB_REF='refs/tags/v2.0.0', GITHUB_REF_TYPE='tag', PREPARE_ENVIRONMENT='production')
        self.git('tag', 'v2.0.0')
        self.command('prepare')
        output = dict(line.split('=', 1) for line in (self.root / 'output').read_text().splitlines())
        production = release.decode(output['plan'])
        self.assertEqual(production['source']['environment'], 'production')
        self.assertNotEqual(production['source']['inputs'], planned['source']['inputs'])

    def test_tags_always_build_both_and_pending_tag_rerun_preserves_artifacts(self):
        self.git('tag', 'v2.0.0')
        self.environment.update(GITHUB_REF='refs/tags/v2.0.0', GITHUB_REF_TYPE='tag')
        _, planned = self.plan()
        self.snapshot['release'] = self.manifest(planned['source'])
        self.snapshot['ancestry'] = planned['source']['revision']
        output, _ = self.plan()
        self.assertEqual((output['server'], output['web']), ('true', 'true'))
        request = {'version': 1, 'baseline': 'e' * 64, 'release': self.snapshot['release']}
        self.snapshot['pending'] = {'request': request, 'stage': 'applied', 'backup': None, 'recovery': False}
        output, retry = self.plan()
        self.assertEqual((output['server'], output['web'], retry['mode']), ('false', 'false', 'retry'))
        self.assertEqual(retry['request'], request)

    def test_unknown_and_runtime_inputs_invalidate_both_images(self):
        for path in ('deploy/livekit.yaml', 'unexpected/new-input', '.github/workflows/deploy-vps.yml', 'api/openapi.yaml'):
            with self.subTest(path=path):
                _, planned = self.plan()
                self.snapshot['release'] = self.manifest(planned['source'])
                self.change(path, 'changed release input')
                output, _ = self.plan()
                self.assertEqual((output['server'], output['web']), ('true', 'true'))

    def test_legacy_protocol_and_checkout_mismatch_fail_closed(self):
        self.snapshot['legacy'] = True
        self.assertIn('migration', self.plan(succeeds=False).stderr)
        self.snapshot = {'token': 'a' * 64, 'release': None, 'installed': 'b' * 64}
        self.assertIn('migrate', self.plan(succeeds=False).stderr)
        self.environment['GITHUB_SHA'] = '0' * 40
        self.assertIn('Checkout', self.plan(succeeds=False).stderr)


class TransportTests(unittest.TestCase):
    def test_ssh_streams_archive_unchanged_pins_host_and_cleans_private_credentials(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ssh = root / 'ssh'
            ssh.write_text('''#!/usr/bin/env python3
import hashlib, json, os
from pathlib import Path
import stat, sys
key = Path(sys.argv[sys.argv.index('-i') + 1])
hosts = Path(next(arg.split('=', 1)[1] for arg in sys.argv if arg.startswith('UserKnownHostsFile=')))
Path(os.environ['SSH_OBSERVATION']).write_text(json.dumps({
    'args': sys.argv[1:], 'input': hashlib.sha256(sys.stdin.buffer.read()).hexdigest(),
    'key_mode': stat.S_IMODE(key.stat().st_mode), 'hosts_mode': stat.S_IMODE(hosts.stat().st_mode),
    'key': str(key), 'hosts': str(hosts)}))
sys.exit(int(os.environ.get('SSH_EXIT', '0')))
''')
            ssh.chmod(0o700)
            observation = root / 'observation.json'
            environment = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'],
                               VPS_HOST='vps.example.invalid', VPS_SSH_KEY='test private key',
                               VPS_KNOWN_HOSTS='test host key', RUNNER_TEMP=str(root),
                               SSH_OBSERVATION=str(observation))
            data = bytes(range(256)) * 40
            for status in ('0', '37'):
                with self.subTest(status=status):
                    environment['SSH_EXIT'] = status
                    result = subprocess.run(['bash', str(ROOT / 'ci-ssh.sh'), 'deploy-release encoded'],
                                            input=data, env=environment, capture_output=True)
                    self.assertEqual(result.returncode, int(status), result.stderr)
                    seen = json.loads(observation.read_text())
                    self.assertEqual(seen['input'], release.sha(data))
                    self.assertEqual(seen['args'][-1], 'deploy-release encoded')
                    for option in ('StrictHostKeyChecking=yes', 'IdentitiesOnly=yes', 'IdentityAgent=none', 'BatchMode=yes'):
                        self.assertIn(option, seen['args'])
                    self.assertEqual((seen['key_mode'], seen['hosts_mode']), (0o600, 0o600))
                    self.assertFalse(Path(seen['key']).exists())
                    self.assertFalse(Path(seen['hosts']).exists())
            observation.unlink()
            environment['VPS_HOST'] = '-oProxyCommand=bad'
            result = subprocess.run(['bash', str(ROOT / 'ci-ssh.sh'), 'release'],
                                    input=b'', env=environment, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(observation.exists())


if __name__ == '__main__':
    unittest.main()
