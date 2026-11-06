"""Falky's deterministic runtime package and locked, recoverable instance operator.

Only the final health gate records success. Container identities and host files
are deliberately absent from the durable baseline. CI checks source ancestry;
the instance checks the exact baseline token under its operation lock.
"""
import base64
from contextlib import contextmanager, closing
import fcntl
import hashlib
from html.parser import HTMLParser
import io
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
from urllib.request import urlopen
from urllib.error import HTTPError
import uuid

VERSION = 1
MAX_PACKAGE = 2 * 1024 * 1024
LEGACY_FILES = ('compose.yaml', 'compose.production.yaml', 'compose.sh', 'manage.sh', 'ci-deploy.sh', 'release.py', 'prune-backups.py', 'Caddyfile', 'WebCaddyfile', 'web.caddy', 'livekit.yaml', '.env', '.release.json')
FILES = ('bootstrap.py', 'ci-deploy.sh', 'compose.production.yaml', 'compose.sh',
         'livekit.yaml', 'manage.sh', 'prune-backups.py', 'release.py')
REPOSITORIES = {'server': 'ghcr.io/luckmorecat/falky', 'web': 'ghcr.io/luckmorecat/falky-web'}
SERVICES = {'server': 'falky', 'web': 'caddy'}
LIVEKIT = 'livekit/livekit-server:v1.13.11@sha256:25cd902de7cacbd5f1f779f6a6ac1eae20ba8f56b0935934ce6b0ab80d1e3d20'
HELPER = 'caddy:2.11.7@sha256:36c24ad91a7ff7bc4c87fe22bfa8df3c4b18da0773d73fc12ee2c52b98c0bb7e'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def digest(value):
    return sha(canonical(value).encode())


def encode(value):
    return base64.urlsafe_b64encode(canonical(value).encode()).decode()


def decode(value):
    require(len(value) <= 16000 and re.fullmatch(r'[A-Za-z0-9_=-]+', value), 'Invalid release encoding')
    return json.loads(base64.b64decode(value, altchars=b'-_', validate=True))


def valid_release(value):
    require(isinstance(value, dict) and set(value) == {'version', 'revision', 'ref', 'environment', 'inputs', 'package', 'images'}, 'Invalid manifest fields')
    require(value['version'] == VERSION and type(value['version']) is int, 'Unsupported manifest version')
    require(isinstance(value['revision'], str) and re.fullmatch('[a-f0-9]{40}', value['revision']), 'Invalid revision')
    require(value['environment'] in ('development', 'production'), 'Invalid environment')
    require(isinstance(value['ref'], str) and len(value['ref']) <= 200 and
            (value['ref'] == 'refs/heads/master' if value['environment'] == 'development' else re.fullmatch(r'refs/tags/v[0-9][A-Za-z0-9.+-]*', value['ref'])), 'Invalid release ref')
    require(isinstance(value['inputs'], dict) and set(value['inputs']) == set(SERVICES), 'Invalid inputs')
    for item in value['inputs'].values():
        require(isinstance(item, str) and re.fullmatch('[a-f0-9]{64}', item), 'Invalid input hash')
    package = value['package']
    require(isinstance(package, dict) and set(package) == {'version', 'sha256', 'size'}, 'Invalid package fields')
    require(type(package['version']) is int and package['version'] == VERSION, 'Unsupported package version')
    require(isinstance(package['sha256'], str) and re.fullmatch('[a-f0-9]{64}', package['sha256']), 'Invalid package digest')
    require(type(package['size']) is int and 0 < package['size'] <= MAX_PACKAGE, 'Invalid package size')
    require(isinstance(value['images'], dict) and set(value['images']) == {'server', 'web', 'livekit'}, 'Invalid images')
    for key, repository in REPOSITORIES.items():
        require(isinstance(value['images'][key], str) and re.fullmatch(re.escape(repository) + '@sha256:[a-f0-9]{64}', value['images'][key]), 'Immutable application image required')
    require(isinstance(value['images']['livekit'], str) and re.fullmatch(r'livekit/livekit-server:v[0-9.]+@sha256:[a-f0-9]{64}', value['images']['livekit']), 'Immutable LiveKit image required')


def valid_request(value):
    require(isinstance(value, dict) and set(value) == {'version', 'baseline', 'release'}, 'Invalid request fields')
    require(type(value['version']) is int and value['version'] == VERSION, 'Invalid request version')
    require(isinstance(value['baseline'], str) and re.fullmatch('[a-f0-9]{64}', value['baseline']), 'Invalid baseline')
    valid_release(value['release'])


def package(source, output):
    contents = {name: (source / name).read_bytes() for name in FILES}
    inventory = {name: {'sha256': sha(data), 'size': len(data), 'mode': 0o700 if name.endswith('.sh') else 0o600} for name, data in contents.items()}
    contents['package.json'] = (canonical({'version': VERSION, 'files': inventory}) + '\n').encode()
    with tarfile.open(output, 'w', format=tarfile.USTAR_FORMAT) as archive:
        for name in sorted(contents):
            info = tarfile.TarInfo(name)
            info.size = len(contents[name])
            info.mode = inventory.get(name, {'mode': 0o600})['mode']
            archive.addfile(info, io.BytesIO(contents[name]))
    data = output.read_bytes()
    require(len(data) <= MAX_PACKAGE, 'Runtime package exceeds size limit')
    return {'version': VERSION, 'sha256': sha(data), 'size': len(data)}


def unpack(data, expected, destination=None):
    require(len(data) == expected['size'] and sha(data) == expected['sha256'], 'Package digest or size mismatch')
    contents = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
        for item in archive:
            require(item.name in (*FILES, 'package.json') and item.name not in contents, 'Unexpected or duplicate package path')
            require(item.isfile() and not item.pax_headers and 0 <= item.size <= MAX_PACKAGE, 'Unsafe archive entry')
            require(sum(len(value) for value in contents.values()) + item.size <= MAX_PACKAGE, 'Expanded package exceeds limit')
            require(item.mode == (0o700 if item.name.endswith('.sh') else 0o600), 'Invalid archive mode')
            contents[item.name] = archive.extractfile(item).read()
    require(set(contents) == {*FILES, 'package.json'}, 'Incomplete package inventory')
    inventory = json.loads(contents['package.json'])
    require(set(inventory) == {'version', 'files'} and inventory['version'] == VERSION and set(inventory['files']) == set(FILES), 'Invalid package inventory')
    for name in FILES:
        require(inventory['files'][name] == {'sha256': sha(contents[name]), 'size': len(contents[name]), 'mode': 0o700 if name.endswith('.sh') else 0o600}, 'Package inventory mismatch')
    if destination:
        destination.mkdir(mode=0o700)
        for name, data in contents.items():
            durable_bytes(destination / name, data, 0o700 if name.endswith('.sh') else 0o600)
        sync_dir(destination)
    return contents


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def durable_bytes(path, data, mode=0o600):
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            os.fchmod(output.fileno(), mode)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        sync_dir(path.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def atomic_write(path, value):
    durable_bytes(path, (canonical(value) + '\n').encode())


def run(*args, env=None, pass_fds=(), input=None):
    # Captured Compose output may contain instance secrets; never print failures.
    result = subprocess.run(args, capture_output=True, text=True, env=env, pass_fds=pass_fds, input=input)
    require(result.returncode == 0, 'Command failed: ' + ('docker compose' if 'compose' in args else args[0]))
    return result.stdout


class Instance:
    def __init__(self, root):
        self.root = root.resolve()
        self.store = self.root / '.deploy'
        self.state_path = self.store / 'state.json'

    @contextmanager
    def locked(self):
        require(self.root.is_dir(), 'Create the instance directory and .env first')
        with open(self.root / '.operations.lock', 'a') as lock:
            deadline = time.monotonic() + int(os.environ.get('FALKY_LOCK_WAIT_SECONDS', '0'))
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    require(time.monotonic() < deadline, 'Another instance operation is running')
                    time.sleep(.1)
            self.store.mkdir(mode=0o700, exist_ok=True)
            sync_dir(self.root)
            for name in ('artifacts', 'packages', 'runtimes'):
                (self.store / name).mkdir(mode=0o700, exist_ok=True)
            sync_dir(self.store)
            self.lock_fd = lock.fileno()
            yield

    def state(self):
        if self.state_path.exists():
            return json.loads(self.state_path.read_text())
        require(not (self.root / '.release-pending.json').exists(), 'Resolve legacy pending attempt explicitly before import')
        state = {'version': VERSION, 'generation': 0, 'active': None, 'successful': None, 'ancestry': None, 'pending': None, 'history': []}
        if (self.root / '.release.json').exists():
            legacy = json.loads((self.root / '.release.json').read_text())
            revision = legacy['release']['revision']
            require(isinstance(revision, str) and re.fullmatch('[a-f0-9]{40}', revision), 'Invalid legacy successful revision')
            state['ancestry'] = revision
            state['legacy'] = legacy
            state['history'].append({'event': 'legacy-import', 'record': legacy})
        return state

    def snapshot(self):
        state = self.state()
        return {'version': VERSION, 'token': digest(state), 'release': state['successful'], 'ancestry': state['ancestry'], 'pending': state['pending'], 'legacy': bool(state.get('legacy'))}

    def save(self, state):
        atomic_write(self.state_path, state)

    def archive(self, manifest):
        return self.store / 'artifacts' / (manifest['package']['sha256'] + '.tar')

    def config(self, manifest=None, directory=None):
        manifest = manifest or self.state()['active']
        require(manifest is not None, 'No installed release; use import-legacy for migration')
        if directory is None:
            directory = self.stage(manifest, self.archive(manifest).read_bytes())
        environment = dict(os.environ)
        # Instance settings come only from .env; release image selection comes only
        # from the manifest, never shell variables or old image keys in .env.
        for key in list(environment):
            if key.startswith(('FALKY_', 'LIVEKIT_', 'COMPOSE_')):
                del environment[key]
        environment.update(FALKY_INSTANCE_DIR=str(self.root), FALKY_IMAGE=manifest['images']['server'],
                           FALKY_WEB_IMAGE=manifest['images']['web'],
                           FALKY_LIVEKIT_CONFIG_SHA=sha((directory / 'livekit.yaml').read_bytes()))
        return ['docker', 'compose', '--project-directory', str(self.root), '--env-file', str(self.root / '.env'),
                '-f', str(directory / 'compose.production.yaml')], environment

    def compose(self, *args, manifest=None, directory=None):
        command, environment = self.config(manifest, directory)
        return run(*command, *args, env=environment)

    def rendered(self, manifest=None, directory=None):
        return json.loads(self.compose('config', '--format', 'json', manifest=manifest, directory=directory))

    def health(self):
        report = json.loads(self.compose('exec', '-T', 'falky', '/falky', 'health', 'ready'))
        require(report.get('status') == 'ok' and report.get('components', {}).get('database') == 'ok' and report.get('components', {}).get('livekit') == 'ok', 'Database or LiveKit health failed')
        domain = self.rendered()['services']['caddy']['environment']['FALKY_DOMAIN']
        origin = 'https://' + domain
        try:
            with urlopen(origin + '/api/me', timeout=15) as response:
                code = response.status
        except HTTPError as error:
            code = error.code
        require(code == 401, 'Public API must reject anonymous visitors with 401')
        class Page(HTMLParser):
            def __init__(self):
                super().__init__()
                self.root = False
                self.assets = []
            def handle_starttag(self, tag, attrs):
                attrs = dict(attrs)
                if tag == 'div' and attrs.get('id') == 'root':
                    self.root = True
                if tag == 'script' and attrs.get('src'):
                    self.assets.append((attrs['src'], 'javascript'))
                if tag == 'link' and attrs.get('rel') == 'stylesheet':
                    self.assets.append((attrs.get('href', ''), 'css'))
        with urlopen(origin + '/', timeout=15) as response:
            require(response.status == 200 and response.headers.get_content_type() == 'text/html', 'Frontend HTML failed')
            page = Page()
            page.feed(response.read(2 * 1024 * 1024).decode())
        require(page.root and any(kind == 'javascript' for _, kind in page.assets), 'Frontend root or JavaScript missing')
        for asset, kind in page.assets:
            require(asset.startswith('/assets/') and not any(c in asset for c in ('\\', '\r', '\n')), 'Unexpected frontend asset path')
            with urlopen(origin + asset, timeout=15) as response:
                require(response.status == 200 and kind in response.headers.get_content_type() and response.read(1), 'Frontend asset failed')

    def integrity(self, path):
        with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)) as database:
            require(database.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'Snapshot integrity check failed')

    def seal_backup(self, directory, names):
        inventory = {name: sha((directory / name).read_bytes()) for name in names}
        atomic_write(directory / 'bundle.json', inventory)
        durable_bytes(directory / 'complete', (sha((directory / 'bundle.json').read_bytes()) + '\n').encode())

    def verify_backup(self, directory):
        inventory_path = directory / 'bundle.json'
        require(not directory.is_symlink() and not inventory_path.is_symlink(), 'Unsafe backup path')
        require((directory / 'complete').read_text().strip() == sha(inventory_path.read_bytes()), 'Backup inventory changed')
        inventory = json.loads(inventory_path.read_text())
        allowed = {'database.db', '.env', 'snapshot.txt', 'legacy.tar', 'legacy.json', 'runtime.tar', 'manifest.json', 'instance.json', 'state.json'}
        require(isinstance(inventory, dict) and set(inventory) <= allowed and {'database.db', '.env', 'snapshot.txt'} <= set(inventory), 'Invalid backup inventory')
        for name, expected in inventory.items():
            path = directory / name
            require(path.is_file() and not path.is_symlink() and sha(path.read_bytes()) == expected, 'Backup file changed: ' + name)
        self.integrity(directory / 'database.db')

    def backup(self, directory, *, required=True):
        if (directory / 'complete').exists():
            self.verify_backup(directory)
            return str(directory.relative_to(self.root))
        state = self.state()
        manifest = state['active']
        if manifest is None:
            # The target config supplies the exact legacy project/volume names.
            pending = state['pending']
            target_dir = self.store / 'packages' / pending['request']['release']['package']['sha256']
            config = self.rendered(pending['request']['release'], target_dir)
            volumes = run('docker', 'volume', 'ls', '--format', '{{.Name}}').splitlines()
            data_name = config['volumes']['falky_data']['name']
            require(data_name not in volumes, 'Retained database has no installed backend snapshot path; import legacy or recover first')
            require(not required, 'Backup requires an installed backend')
            return None
        container = self.compose('ps', '--all', '--quiet', 'falky').strip()
        require(container and '\n' not in container, 'Backup requires the existing backend container')
        require(run('docker', 'inspect', '--format', '{{.State.Running}}', container).strip() == 'true', 'Backup requires a running backend')
        directory.parent.mkdir(mode=0o700, exist_ok=True)
        sync_dir(self.root)
        directory.mkdir(mode=0o700, exist_ok=True)
        sync_dir(directory.parent)
        snapshot = self.compose('exec', '-T', 'falky', '/falky', 'snapshot').strip()
        require(re.fullmatch(r'/snapshots/falky-[0-9]{8}T[0-9]{6}Z\.db', snapshot), 'Unexpected snapshot path')
        self.compose('cp', 'falky:' + snapshot, str(directory / 'database.db'))
        os.chmod(directory / 'database.db', 0o600)
        self.integrity(directory / 'database.db')
        with open(directory / 'database.db', 'rb') as db:
            os.fsync(db.fileno())
        archive = self.archive(manifest).read_bytes()
        unpack(archive, manifest['package'])
        durable_bytes(directory / 'runtime.tar', archive)
        durable_bytes(directory / '.env', (self.root / '.env').read_bytes())
        atomic_write(directory / 'manifest.json', manifest)
        atomic_write(directory / 'instance.json', {'root': str(self.root), 'data_volume': self.rendered()['volumes']['falky_data']['name']})
        atomic_write(directory / 'state.json', state)
        durable_bytes(directory / 'snapshot.txt', (snapshot + '\n').encode())
        self.seal_backup(directory, ('database.db', 'runtime.tar', '.env', 'manifest.json', 'instance.json', 'state.json', 'snapshot.txt'))
        return str(directory.relative_to(self.root))

    def prune(self, directory):
        run('docker', 'pull', HELPER)
        container = self.compose('ps', '--all', '--quiet', 'falky').strip()
        run(sys.executable, str(self.root / 'active/prune-backups.py'), str(directory), container, HELPER)

    def stage(self, manifest, data):
        contents = unpack(data, manifest['package'])
        # Verify declared LiveKit identity without executing code from the package.
        require(re.search(r'^    image: ' + re.escape(manifest['images']['livekit']) + r'\s*$', contents['compose.production.yaml'].decode(), re.M), 'Package LiveKit image differs from manifest')
        durable_bytes(self.archive(manifest), data)
        destination = self.store / 'packages' / manifest['package']['sha256']
        temporary = self.store / 'packages' / ('.stage-' + uuid.uuid4().hex)
        unpack(data, manifest['package'], temporary)
        if destination.exists():
            shutil.rmtree(destination)
        os.replace(temporary, destination)
        sync_dir(destination.parent)
        return destination

    def activate(self, manifest):
        directory = self.store / 'runtimes' / uuid.uuid4().hex
        unpack(self.archive(manifest).read_bytes(), manifest['package'], directory)
        # A stable bind path plus a content digest label lets Compose recreate
        # LiveKit only when bytes change, independent of package directory names.
        durable_bytes(self.store / 'livekit.yaml', (directory / 'livekit.yaml').read_bytes())
        temporary = self.root / ('.active-' + uuid.uuid4().hex)
        temporary.symlink_to(directory.relative_to(self.root))
        os.replace(temporary, self.root / 'active')
        sync_dir(self.root)
        for name in ('manage.sh', 'compose.sh', 'ci-deploy.sh'):
            durable_bytes(self.root / name, (directory / name).read_bytes(), 0o700)

    def install(self, request, data=None, retry=False, recovery=False, migrate=False):
        valid_request(request)
        state = self.state()
        pending = state['pending']
        require(not state['successful'] or state['successful']['environment'] == request['release']['environment'], 'Release environment differs from this instance')
        require(not state.get('legacy') or migrate or (retry and pending), 'Legacy installation requires explicit migrate')
        require(not migrate or state.get('legacy'), 'Instance already migrated')
        if pending is None and retry and state['history'] and state['history'][-1].get('request') == request and state['history'][-1]['event'] == 'success':
            return  # Completion and pending removal are one durable write.
        if pending:
            require(pending['request'] == request, 'Different pending target; explicit resolve-pending is required')
            require(retry, 'Pending target exists; use retry-release with its exact request')
            if pending.get('restore'):
                return self.restore(pending['restore'])
            data = self.archive(request['release']).read_bytes()
        else:
            require(not retry, 'No pending release to retry')
            require(request['baseline'] == self.snapshot()['token'], 'Stale release plan; plan again')
            require(data is not None, 'Runtime archive required on stdin')
        directory = self.stage(request['release'], data)
        config = self.rendered(request['release'], directory)
        require({service['image'] for service in config['services'].values()} == set(request['release']['images'].values()) and set(config['services']) == {'falky', 'caddy', 'livekit'}, 'Package must declare exactly the full manifest stack')
        for image in request['release']['images'].values():
            run('docker', 'pull', image)
        if pending is None:
            pending = {'request': request, 'stage': 'snapshot', 'backup': 'backups/' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid.uuid4().hex[:6], 'recovery': recovery, 'migration': bool(state.get('legacy'))}
            state['pending'] = pending
            self.save(state)
        if pending['stage'] == 'snapshot':
            try:
                if pending.get('migration'):
                    self.legacy_backup(self.root / pending['backup'])
                    backup = pending['backup']
                else:
                    backup = self.backup(self.root / pending['backup'], required=False)
            except Exception:
                # A clean snapshot failure has not mutated the app. Keep evidence,
                # but allow CI to rebuild/replan. Abrupt process loss keeps pending.
                state['history'].append({'event': 'snapshot-failed', 'request': request, 'backup': pending['backup']})
                state['pending'] = None
                state['generation'] += 1
                self.save(state)
                raise
            pending['backup'] = backup
            pending['stage'] = 'prepared'
            state['history'].append({'event': 'attempt', 'request': request, 'backup': backup})
            self.save(state)
        if pending['stage'] == 'prepared':
            self.activate(request['release'])
            state['active'] = request['release']
            pending['stage'] = 'activated'
            self.save(state)
        # Run the newly verified operator for the rest of the transaction, keeping
        # the SAME lock FD. The caller stays alive holding flock while the child
        # runs, so self-updates cannot accidentally use stale operator behavior.
        if Path(__file__).resolve() != (self.root / 'active/release.py').resolve():
            run(sys.executable, str(self.root / 'active/release.py'), '--continue-locked', str(self.root), encode(request), str(self.lock_fd), pass_fds=(self.lock_fd,))
            return
        self.complete(request)

    def legacy_backup(self, directory):
        if (directory / 'complete').exists():
            self.verify_backup(directory)
            return
        directory.parent.mkdir(mode=0o700, exist_ok=True)
        sync_dir(self.root)
        directory.mkdir(mode=0o700, exist_ok=True)
        sync_dir(directory.parent)
        # Read actual old bytes; never execute an old operator or compare its
        # host fingerprints. This path is used only by the explicit migration.
        contents = {}
        for name in LEGACY_FILES:
            path = self.root / name
            require(path.is_file() and not path.is_symlink(), 'Legacy recovery file missing: ' + name)
            contents[name] = path.read_bytes()
        command = ['docker', 'compose', '--project-directory', str(self.root), '--env-file', str(self.root / '.env'), '-f', str(self.root / 'compose.yaml'), '-f', str(self.root / 'compose.production.yaml')]
        environment = {key: value for key, value in os.environ.items() if not key.startswith(('FALKY_', 'LIVEKIT_', 'COMPOSE_'))}
        config = json.loads(run(*command, 'config', '--format', 'json', env=environment))
        images = {}
        for service in ('falky', 'caddy', 'livekit'):
            reference = config['services'][service]['image']
            require(re.fullmatch(r'(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}', reference), 'Legacy image must be immutable')
            image_id = run('docker', 'image', 'inspect', '--format', '{{.Id}}', reference).strip()
            require(re.fullmatch('sha256:[a-f0-9]{64}', image_id), 'Legacy recovery image unavailable')
            images[service] = {'reference': reference, 'id': image_id}
        containers = {}
        configured_volumes = {}
        for service in ('falky', 'caddy', 'livekit'):
            container = run(*command, 'ps', '--all', '--quiet', service, env=environment).strip()
            require('\n' not in container, 'Expected at most one legacy ' + service + ' container')
            if service == 'falky':
                require(container and run('docker', 'inspect', '--format', '{{.State.Running}}', container).strip() == 'true', 'Migration requires existing backend snapshot path')
            if not container:
                # Missing old UI/signalling must not prevent a corrective deploy.
                # The configured immutable image remains the recovery reference.
                containers[service] = None
                continue
            actual_image = json.loads(run('docker', 'inspect', '--format', '{{json .Image}}', container))
            require(actual_image == images[service]['id'], 'Legacy ' + service + ' image differs from configured recovery image; reconcile before migration')
            containers[service] = {'image': actual_image}
            if service == 'falky':
                mounts = json.loads(run('docker', 'inspect', '--format', '{{json .Mounts}}', container))
                actual_volumes = {}
                for target in ('/data', '/snapshots'):
                    declared = [mount for mount in config['services']['falky']['volumes'] if mount['target'] == target]
                    require(len(declared) == 1 and declared[0]['type'] == 'volume', 'Legacy backend requires a configured ' + target + ' volume')
                    expected = config['volumes'][declared[0]['source']]['name']
                    actual = [mount for mount in mounts if mount['Destination'] == target]
                    require(len(actual) == 1 and actual[0]['Type'] == 'volume' and actual[0]['Name'] == expected,
                            'Legacy backend ' + target + ' mount differs from configured recovery volume; reconcile before migration')
                    configured_volumes[target] = expected
                    actual_volumes[target] = actual[0]['Name']
                containers[service]['volumes'] = actual_volumes
        snapshot = run(*command, 'exec', '-T', 'falky', '/falky', 'snapshot', env=environment).strip()
        require(re.fullmatch(r'/snapshots/falky-[0-9]{8}T[0-9]{6}Z\.db', snapshot), 'Unexpected snapshot path')
        run(*command, 'cp', 'falky:' + snapshot, str(directory / 'database.db'), env=environment)
        self.integrity(directory / 'database.db')
        os.chmod(directory / 'database.db', 0o600)
        with open(directory / 'database.db', 'rb') as database:
            os.fsync(database.fileno())
        with io.BytesIO() as output:
            with tarfile.open(fileobj=output, mode='w', format=tarfile.USTAR_FORMAT) as archive:
                for name, data in sorted(contents.items()):
                    info = tarfile.TarInfo(name); info.size = len(data); info.mode = 0o600
                    archive.addfile(info, io.BytesIO(data))
            durable_bytes(directory / 'legacy.tar', output.getvalue())
        atomic_write(directory / 'legacy.json', {'version': 1, 'files': {name: sha(data) for name, data in contents.items()}, 'images': images, 'containers': containers, 'configured_volumes': configured_volumes, 'record': self.state()['legacy'], 'data_volume': configured_volumes['/data'], 'root': str(self.root)})
        durable_bytes(directory / '.env', contents['.env'])
        durable_bytes(directory / 'snapshot.txt', (snapshot + '\n').encode())
        self.seal_backup(directory, ('database.db', 'legacy.tar', 'legacy.json', '.env', 'snapshot.txt'))

    def restore(self, name):
        require(re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-[a-f0-9]{6}', name), 'Select a completed backup by its directory name')
        directory = self.root / 'backups' / name
        require(not directory.is_symlink() and (directory / 'complete').is_file(), 'Incomplete backup')
        self.verify_backup(directory)
        identity = json.loads((directory / 'instance.json').read_text())
        require(identity['root'] == str(self.root), 'Backup belongs to another instance')
        manifest = json.loads((directory / 'manifest.json').read_text())
        valid_release(manifest)
        data = (directory / 'runtime.tar').read_bytes()
        staged = self.stage(manifest, data)
        require(self.rendered(manifest, staged)['volumes']['falky_data']['name'] == identity['data_volume'], 'Database volume identity changed')
        state = self.state()
        pending = state['pending']
        if pending:
            require(pending.get('restore') == name, 'Resolve the pending attempt before selecting a restore')
        else:
            for image in manifest['images'].values():
                run('docker', 'pull', image)
            request = {'version': VERSION, 'baseline': self.snapshot()['token'], 'release': manifest}
            pending = {'request': request, 'stage': 'restore', 'backup': 'backups/' + name, 'restore': name, 'recovery': True}
            state['pending'] = pending
            state['history'].append({'event': 'restore-attempt', 'request': request, 'backup': pending['backup']})
            self.save(state)
        if pending['stage'] == 'restore':
            # Explicit restore is the only operation which discards the database.
            # Repeating before the durable marker is safe: no app can run yet.
            if state['active']:
                self.compose('down')
            durable_bytes(self.root / '.env', (directory / '.env').read_bytes())
            self.activate(manifest)
            state['active'] = manifest
            self.save(state)
            run('docker', 'volume', 'rm', '--force', '--', identity['data_volume'])
            command, environment = self.config(manifest)
            with open(directory / 'database.db', 'rb') as database:
                result = subprocess.run(command + ['run', '--rm', '--no-deps', '-T', 'falky', 'restore'], stdin=database, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=environment)
            require(result.returncode == 0, 'Backend snapshot restore failed')
            pending['stage'] = 'activated'
            self.save(state)
        run(sys.executable, str(self.root / 'active/release.py'), '--continue-locked', str(self.root), encode(pending['request']), str(self.lock_fd), pass_fds=(self.lock_fd,))

    def complete(self, request):
        state = self.state()
        pending = state['pending']
        require(pending and pending['request'] == request and pending['stage'] in ('activated', 'applied'), 'Invalid continuation')
        self.compose('up', '--detach', '--no-build', '--wait', '--wait-timeout', '180')
        pending['stage'] = 'applied'
        self.save(state)
        for attempt in range(18):
            try:
                self.health()
                break
            except (ValueError, OSError):
                if attempt == 17:
                    raise
                time.sleep(5)
        state['active'] = request['release']
        state['successful'] = request['release']
        if not pending['recovery']:
            state['ancestry'] = request['release']['revision']
        state['generation'] += 1
        state['history'].append({'event': 'success', 'request': request, 'backup': pending['backup'], 'recovery': pending['recovery'], 'restore': pending.get('restore')})
        state['pending'] = None
        state.pop('legacy', None)
        self.save(state)
        if pending.get('backup'):
            try:
                self.prune(self.root / pending['backup'])
            except (ValueError, OSError):
                print('Release succeeded; backup retention failed, run backup to retry retention', file=sys.stderr)


def main():
    os.umask(0o077)
    try:
        args = sys.argv[1:]
        if args[0] == 'package':
            require(len(args) == 2, 'Usage: release.py package output.tar')
            print(canonical(package(Path(__file__).resolve().parent, Path(args[1]))))
            return
        if args[0] == '--continue-locked':
            # Internal invocation only: parent retains the lock during the child.
            instance = Instance(Path(args[1]))
            fd = int(args[3])
            require(os.fstat(fd).st_ino == (instance.root / '.operations.lock').stat().st_ino, 'Invalid operation lock')
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            instance.complete(decode(args[2]))
            return
        require(len(args) >= 3 and args[0] == '--instance', 'Usage: bootstrap.py --instance DIR operation [arguments]')
        instance = Instance(Path(args[1]))
        os.chdir(instance.root)
        operation, operands = args[2], args[3:]
        with instance.locked():
            if operation == 'release' and not operands:
                print(canonical(instance.snapshot()))
            elif operation in ('install', 'deploy-release', 'retry-release', 'migrate') and len(operands) == 1:
                request = decode(operands[0])
                valid_request(request)
                data = None if operation == 'retry-release' else sys.stdin.buffer.read(MAX_PACKAGE + 1)
                instance.install(request, data, retry=operation == 'retry-release', migrate=operation == 'migrate')
            elif operation == 'compose':
                command, environment = instance.config()
                # Let interactive room/link commands and streaming logs use the
                # terminal directly; do not keep the operation lock for log tails.
                if operands and operands[0] in ('logs', 'ps', 'exec'):
                    fcntl.flock(instance.lock_fd, fcntl.LOCK_UN)
                result = subprocess.run(command + operands, env=environment)
                require(result.returncode == 0, 'Compose command failed')
            elif operation == 'status' and not operands:
                print(instance.compose('ps'), end='')
                instance.health()
            elif operation == 'backup' and not operands:
                directory = instance.root / 'backups' / (time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid.uuid4().hex[:6])
                instance.backup(directory)
                instance.prune(directory)
                print(str(directory))
            elif operation == 'record-legacy-recovery' and len(operands) == 1:
                require(re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-[a-f0-9]{6}', operands[0]), 'Invalid legacy backup name')
                directory = instance.root / 'backups' / operands[0]
                require((directory / 'complete').is_file(), 'Incomplete legacy backup')
                instance.verify_backup(directory)
                evidence = json.loads((directory / 'legacy.json').read_text())
                require(evidence['root'] == str(instance.root), 'Backup belongs to another instance')
                state = instance.state()
                require(not state['pending'], 'Resolve pending attempt explicitly before legacy recovery')
                state['history'].append({'event': 'legacy-recovery', 'backup': str(directory.relative_to(instance.root))})
                state['legacy'] = evidence['record']
                state['active'] = None
                state['generation'] += 1
                instance.save(state)
            elif operation == 'restore' and len(operands) == 1:
                instance.restore(operands[0])
            elif operation == 'resolve-pending' and len(operands) == 1:
                state = instance.state()
                require(state['pending'] and digest(state['pending']['request']) == operands[0], 'Supply the pending request SHA256 to acknowledge resolution')
                state['history'].append({'event': 'resolved', 'pending': state['pending']})
                state['pending'] = None
                state['generation'] += 1
                instance.save(state)
            else:
                raise ValueError('Unknown instance operation or invalid arguments')
    except (ValueError, KeyError, TypeError, OSError, sqlite3.Error, tarfile.TarError) as error:
        print('Release refused: ' + str(error), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
