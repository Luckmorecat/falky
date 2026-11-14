"""Exercise package installs through the operator CLI; fake only Docker/HTTPS/time."""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
SERVER = 'ghcr.io/luckmorecat/falky'
WEB = SERVER + '-web'
LIVEKIT = 'livekit/livekit-server:v1.13.11@sha256:25cd902de7cacbd5f1f779f6a6ac1eae20ba8f56b0935934ce6b0ab80d1e3d20'
FAKE_DOCKER = r'''
import json, os, sqlite3, sys
from pathlib import Path
args = sys.argv[1:]
with open('calls.jsonl', 'a') as out: out.write(json.dumps(args) + '\n')
if args[0] == 'pull':
    sys.exit(1 if os.environ.get('FAIL_PULL') == args[1] else 0)
if args[:2] == ['volume','rm']:
    Path('database-writes').unlink(missing_ok=True)
    sys.exit(0)
if args[:2] == ['volume','ls']:
    if Path('database-present').exists(): print('falky_falky_data')
    sys.exit(0)
if args[:2] == ['image','inspect']:
    if '--format' in args: print('sha256:'+'f'*64)
    sys.exit(0)
if args[:2] == ['volume','inspect']: sys.exit(0)
if args[0] == 'inspect':
    if 'Mounts' in args[2]:
        print(json.dumps([
            {'Destination':'/data','Type':'volume','Name':os.environ.get('ACTUAL_DATA_VOLUME','falky_falky_data')},
            {'Destination':'/snapshots','Type':'volume','Name':os.environ.get('ACTUAL_SNAPSHOT_VOLUME','falky_falky_snapshots')},
        ]))
    elif 'json .Image' in args[2]:
        print(json.dumps('sha256:'+('e' if os.environ.get('DRIFT_IMAGE_SERVICE') == args[-1].removesuffix('-container') else 'f')*64))
    else: print('true')
    sys.exit(0)
if args[0] == 'run':
    if 'find' in args:
        for path in Path('snapshot-volume').glob('*.db'): sys.stdout.write('/snapshots/' + path.name + '\0')
    sys.exit(0)
if args[0] == 'compose':
    last=max(index for index,item in enumerate(args) if item == '-f')
    command=args[last+2:]
    os.environ.setdefault('FALKY_IMAGE','ghcr.io/luckmorecat/falky@sha256:'+'a'*64)
    os.environ.setdefault('FALKY_WEB_IMAGE','ghcr.io/luckmorecat/falky-web@sha256:'+'a'*64)
    if command[0] == 'config':
        print(json.dumps({'name':'falky','services':{'falky':{'image':os.environ['FALKY_IMAGE'],'volumes':[{'type':'volume','source':'falky_data','target':'/data'},{'type':'volume','source':'falky_snapshots','target':'/snapshots'}]},'caddy':{'image':os.environ['FALKY_WEB_IMAGE'],'environment':{'FALKY_DOMAIN':'test.invalid'}},'livekit':{'image':'livekit/livekit-server:v1.13.11@sha256:25cd902de7cacbd5f1f779f6a6ac1eae20ba8f56b0935934ce6b0ab80d1e3d20'}},'volumes':{'falky_data':{'name':'falky_falky_data'},'falky_snapshots':{'name':'falky_falky_snapshots'}}}))
    elif command[0] == 'ps':
        service=command[-1]
        missing=os.environ.get('MISSING_BACKEND') if service == 'falky' else os.environ.get('MISSING_OLD_UI') and service == 'caddy'
        if Path('database-present').exists() and not missing: print(service+'-container')
    elif command[0] == 'up':
        Path('database-present').touch()
        if os.environ.get('FAIL_UP'): sys.exit(1)
    elif command[0] == 'exec':
        if command[-1] == 'snapshot':
            if os.environ.get('FAIL_SNAPSHOT'): sys.exit(1)
            root=Path('snapshot-volume'); root.mkdir(exist_ok=True)
            name='falky-20261106T030000Z.db'; (root/name).touch()
            print('/snapshots/'+name)
        else:
            print(json.dumps({'status':'ok','components':{'database':'ok','livekit':'failed' if os.environ.get('FAIL_HEALTH') else 'ok'}}))
    elif command[0] == 'cp':
        if os.environ.get('CORRUPT_COPY'): Path(command[-1]).write_bytes(b'broken database')
        else:
            db=sqlite3.connect(command[-1]); db.execute('CREATE TABLE IF NOT EXISTS sample (value TEXT)'); db.commit(); db.close()
    sys.exit(0)
raise SystemExit('Unexpected Docker: '+str(args))
'''
SITE = r'''
import io, json, os, time, urllib.request, urllib.error
from email.message import Message
# Accelerate only retry waits; all filesystem/Docker behavior remains real.
time.sleep=lambda seconds: None
class Response(io.BytesIO):
    def __init__(self, data, content_type):
        super().__init__(data); self.status=200; self.headers=Message(); self.headers['Content-Type']=content_type

def urlopen(url, timeout):
    if url.endswith('/api/me'): raise urllib.error.HTTPError(url,401,'unauthorized',{},None)
    if os.environ.get('FAIL_WEB'): raise OSError('old UI unavailable')
    if '/assets/' in url: return Response(b'javascript', 'application/javascript')
    return Response(b'<div id="root"></div><script src="/assets/app.js"></script>', 'text/html')
urllib.request.urlopen=urlopen
original_replace=os.replace
def replace(source, target):
    original_replace(source,target)
    stop=os.environ.get('INTERRUPT_AFTER')
    if stop and str(target).endswith('/state.json'):
        state=json.load(open(target)); pending=state.get('pending')
        if (pending and pending['stage'] == stop) or (not pending and stop == 'success'):
            os._exit(91)
    if stop == 'activation' and str(target).endswith('/active'): os._exit(91)
os.replace=replace
'''

def encode(value): return base64.urlsafe_b64encode(json.dumps(value).encode()).decode()

class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)/'instance'; self.root.mkdir()
        self.env_text='FALKY_DOMAIN=test.invalid\nFALKY_LIVEKIT_API_SECRET=secret-must-survive\nFALKY_PROJECT_NAME=falky\n'
        (self.root/'.env').write_text(self.env_text)
        binary=Path(self.temp.name)/'bin'; binary.mkdir()
        # Only the operator needs sitecustomize's HTTP and interruption hooks.
        (binary/'docker').write_text('#!'+sys.executable+' -S\n'+FAKE_DOCKER); (binary/'docker').chmod(0o700)
        (binary/'sitecustomize.py').write_text(SITE)
        self.env=os.environ | {'PATH':str(binary)+':'+os.environ['PATH'], 'PYTHONPATH':str(binary)}
        self.archive=Path(self.temp.name)/'runtime.tar'
        result=subprocess.run([sys.executable,str(ROOT/'release.py'),'package',str(self.archive)],capture_output=True,text=True,check=True)
        self.metadata=json.loads(result.stdout)
    def call(self, command, *args, data=None, fail=False, env=None):
        result=subprocess.run([sys.executable,str(ROOT/'bootstrap.py'),'--instance',str(self.root),command,*args],input=data,capture_output=True,env=self.env | (env or {}))
        if fail: self.assertNotEqual(result.returncode,0,result.stdout)
        else: self.assertEqual(result.returncode,0,result.stderr.decode())
        return result
    def snapshot(self): return json.loads(self.call('release').stdout)
    def request(self, letter='a'):
        return {'version':1,'baseline':self.snapshot()['token'],'release':{'version':1,'revision':letter*40,'ref':'refs/heads/master','environment':'development','inputs':{'server':letter*64,'web':letter*64},'package':self.metadata,'images':{'server':SERVER+'@sha256:'+letter*64,'web':WEB+'@sha256:'+letter*64,'livekit':LIVEKIT}}}
    def install(self, letter='a', **kwargs):
        request=self.request(letter); self.call('install',encode(request),data=self.archive.read_bytes(),**kwargs); return request
    def calls(self): return [json.loads(line) for line in (self.root/'calls.jsonl').read_text().splitlines()]
    def test_operation_lock_covers_planning_and_installation(self):
        request=self.request()
        with open(self.root/'.operations.lock','a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.call('release',fail=True)
            self.call('install',encode(request),data=self.archive.read_bytes(),fail=True)
        self.assertFalse((self.root/'active').exists())
    def test_forced_command_refuses_shell_and_arbitrary_transfers(self):
        self.install()
        for command in ('scp -t /tmp/file','sftp','deploy-release abc; id','retry-release abc extra','migrate abc','restore anything','compose exec falky sh'):
            with self.subTest(command=command):
                result=subprocess.run([str(self.root/'ci-deploy.sh')],env=self.env | {'SSH_ORIGINAL_COMMAND':command},capture_output=True)
                self.assertEqual(result.returncode,2,result.stderr)
    def test_installs_complete_package_preserves_settings_and_uses_full_stack(self):
        request=self.install()
        self.assertEqual(self.snapshot()['release'],request['release'])
        self.assertEqual(self.snapshot()['ancestry'],'a'*40)
        self.assertEqual((self.root/'.env').read_text(),self.env_text)
        self.assertTrue((self.root/'active/release.py').is_file())
        up=[args for args in self.calls() if 'up' in args]
        self.assertEqual(up[0][up[0].index('up'):],['up','--detach','--no-build','--wait','--wait-timeout','180'])
    def test_staging_instance_refuses_a_release_from_another_environment(self):
        request=self.request()
        request['release'].update(environment='staging',ref='refs/heads/staging')
        self.call('install',encode(request),data=self.archive.read_bytes())
        self.assertEqual(self.snapshot()['release'],request['release'])
        other=self.request('b')
        result=self.call('install',encode(other),data=self.archive.read_bytes(),fail=True)
        self.assertIn(b'Release environment differs from this instance',result.stderr)
        self.assertEqual(self.snapshot()['release'],request['release'])
        self.assertIsNone(self.snapshot()['pending'])
    def test_exact_retry_after_failed_apply_preserves_original_backup(self):
        self.install()
        request=self.install('b',fail=True,env={'FAIL_UP':'1'})
        pending=self.snapshot()['pending']; self.assertEqual(pending['stage'],'activated')
        original=(self.root/pending['backup']/'database.db').read_bytes()
        before=sum(args[-1:] == ['snapshot'] for args in self.calls())
        self.call('retry-release',encode(request))
        self.assertEqual((self.root/pending['backup']/'database.db').read_bytes(),original)
        self.assertEqual(sum(args[-1:] == ['snapshot'] for args in self.calls()),before)
        self.assertIsNone(self.snapshot()['pending'])
        self.call('retry-release',encode(request))
        self.assertEqual(sum(args[-1:] == ['snapshot'] for args in self.calls()),before)
    def test_interrupted_journal_boundaries_reuse_original_backup(self):
        self.install()
        for index, stage in enumerate(('prepared','activation','activated','applied','success')):
            with self.subTest(stage=stage):
                request=self.install(chr(ord('b')+index),fail=True,env={'INTERRUPT_AFTER':stage})
                before=sum(args[-1:] == ['snapshot'] for args in self.calls())
                self.call('retry-release',encode(request))
                self.assertEqual(sum(args[-1:] == ['snapshot'] for args in self.calls()),before)
                self.assertIsNone(self.snapshot()['pending'])
                self.assertEqual(self.snapshot()['release'],request['release'])
    def legacy_fixture(self):
        old={'release':{'revision':'9'*40,'images':{'server':{'digest':SERVER+'@sha256:'+'9'*64}}},'runtime':'old-runtime-fingerprint'}
        for name in ('compose.yaml','compose.production.yaml','compose.sh','manage.sh','ci-deploy.sh','release.py','prune-backups.py','Caddyfile','WebCaddyfile','web.caddy','livekit.yaml'):
            (self.root/name).write_text('genuine legacy '+name)
        (self.root/'.release.json').write_text(json.dumps(old))
        (self.root/'database-present').touch()
        return old
    def test_legacy_migration_preserves_genuine_old_bytes_and_ancestry(self):
        old=self.legacy_fixture()
        self.assertEqual(self.snapshot()['ancestry'],'9'*40)
        request=self.request('a')
        self.call('migrate',encode(request),data=self.archive.read_bytes(),fail=True,env={'FAIL_UP':'1'})
        pending=self.snapshot()['pending']
        self.assertEqual(self.snapshot()['ancestry'],'9'*40)
        backup=self.root/pending['backup']
        self.assertTrue((backup/'legacy.tar').exists())
        self.assertFalse((backup/'runtime.tar').exists())
        import tarfile
        with tarfile.open(backup/'legacy.tar') as archive:
            self.assertEqual(archive.extractfile('compose.yaml').read(),b'genuine legacy compose.yaml')
            self.assertEqual(json.load(archive.extractfile('.release.json')),old)
        self.call('retry-release',encode(request))
        self.assertEqual(self.snapshot()['ancestry'],'a'*40)
        self.call('migrate',encode(request),data=self.archive.read_bytes(),fail=True)
    def test_legacy_migration_refuses_incoherent_running_image_or_volume(self):
        self.legacy_fixture()
        for environment, message in (
            ({'DRIFT_IMAGE_SERVICE':'falky'}, 'Legacy falky image differs'),
            ({'DRIFT_IMAGE_SERVICE':'caddy'}, 'Legacy caddy image differs'),
            ({'DRIFT_IMAGE_SERVICE':'livekit'}, 'Legacy livekit image differs'),
            ({'ACTUAL_DATA_VOLUME':'other_data'}, 'Legacy backend /data mount differs'),
            ({'ACTUAL_SNAPSHOT_VOLUME':'other_snapshots'}, 'Legacy backend /snapshots mount differs'),
        ):
            with self.subTest(environment=environment):
                request=self.request('a')
                before=len(self.calls()) if (self.root/'calls.jsonl').exists() else 0
                result=self.call('migrate',encode(request),data=self.archive.read_bytes(),fail=True,env=environment)
                self.assertIn(message,result.stderr.decode())
                self.assertFalse((self.root/'active').exists())
                self.assertEqual((self.root/'manage.sh').read_text(),'genuine legacy manage.sh')
                self.assertFalse(any(args[-1:] == ['snapshot'] or 'up' in args for args in self.calls()[before:]))
                self.assertEqual(self.snapshot()['ancestry'],'9'*40)
    def test_legacy_migration_allows_missing_ui_and_records_actual_backend(self):
        self.legacy_fixture()
        request=self.request('a')
        self.call('migrate',encode(request),data=self.archive.read_bytes(),env={'MISSING_OLD_UI':'1'})
        backup=next((self.root/'backups').iterdir())
        evidence=json.loads((backup/'legacy.json').read_text())
        self.assertEqual(evidence['containers']['falky']['image'],'sha256:'+'f'*64)
        self.assertEqual(evidence['containers']['falky']['volumes'],{'/data':'falky_falky_data','/snapshots':'falky_falky_snapshots'})
        self.assertIsNone(evidence['containers']['caddy'])
        self.assertEqual(evidence['images']['caddy']['id'],'sha256:'+'f'*64)
        self.assertEqual(self.snapshot()['ancestry'],'a'*40)
    def test_explicit_restore_preserves_artifacts_and_discards_new_writes(self):
        self.install('a'); self.install('b')
        backups=list((self.root/'backups').iterdir()); self.assertEqual(len(backups),1)
        backup=backups[0]
        self.call('restore',backup.name)
        restored=self.snapshot()
        self.assertEqual(restored['release']['revision'],'a'*40)
        self.assertEqual(restored['ancestry'],'b'*40)
        self.assertIsNone(restored['pending'])
        self.assertTrue((backup/'runtime.tar').is_file())
        self.assertTrue(any(args[:2] == ['volume','rm'] for args in self.calls()))
        (self.root/'database-writes').write_text('new application writes after restore')
        self.call('backup')
        before=sum(args[:2] == ['volume','rm'] for args in self.calls())
        self.call('restore',backup.name)
        self.assertEqual(sum(args[:2] == ['volume','rm'] for args in self.calls()),before+1)
        self.assertFalse((self.root/'database-writes').exists())
        self.assertEqual(self.snapshot()['ancestry'],'b'*40)
    def test_restore_rejects_changed_backup_before_mutation(self):
        self.install('a'); self.install('b')
        backup=next((self.root/'backups').iterdir())
        (backup/'.env').write_text('FALKY_PROJECT_NAME=other-instance')
        before=self.snapshot(); calls=len(self.calls())
        self.call('restore',backup.name,fail=True)
        self.assertEqual(self.snapshot(),before)
        self.assertFalse(any('down' in args or args[:2] == ['volume','rm'] for args in self.calls()[calls:]))
    def test_restore_retry_never_overwrites_database_after_apply(self):
        self.install('a'); self.install('b')
        backup=next((self.root/'backups').iterdir())
        self.call('restore',backup.name,fail=True,env={'INTERRUPT_AFTER':'applied'})
        request=self.snapshot()['pending']['request']
        before=sum(args[:2] == ['volume','rm'] for args in self.calls())
        self.call('retry-release',encode(request))
        self.call('retry-release',encode(request))
        self.assertEqual(sum(args[:2] == ['volume','rm'] for args in self.calls()),before)
        self.assertEqual(self.snapshot()['ancestry'],'b'*40)
    def test_pending_backup_is_pinned_during_retention(self):
        self.install('a'); request=self.install('b',fail=True,env={'FAIL_UP':'1'})
        pending=self.snapshot()['pending']; pinned=self.root/pending['backup']
        for index in range(12):
            destination=self.root/'backups'/('20990101T030000Z-%06x'%index)
            shutil.copytree(pinned,destination)
        self.call('backup')
        self.assertTrue((pinned/'complete').exists())
        self.assertTrue(any('--network' in args and args[args.index('--network')+1] == 'none' and '--cap-drop' in args and '--user' in args for args in self.calls()))
    def test_pull_failure_preserves_active_package_and_settings(self):
        self.install(); active=(self.root/'active').readlink(); before=self.snapshot()
        self.install('b',fail=True,env={'FAIL_PULL':WEB+'@sha256:'+'b'*64})
        self.assertEqual((self.root/'active').readlink(),active)
        self.assertEqual(self.snapshot(),before)
    def test_missing_old_ui_does_not_prevent_snapshot_or_planning(self):
        self.install(); before=self.snapshot()
        self.call('release',env={'FAIL_WEB':'1','FAIL_HEALTH':'1'})
        self.assertEqual(self.snapshot(),before)
        request=self.install('b',fail=True,env={'FAIL_WEB':'1'})
        self.assertEqual(self.snapshot()['pending']['stage'],'applied')
        self.assertEqual(self.snapshot()['ancestry'],'a'*40)
        self.call('retry-release',encode(request))
    def test_resolving_failed_attempt_keeps_successful_planning_baseline(self):
        self.install('a'); request=self.install('b',fail=True,env={'FAIL_UP':'1'})
        acknowledgement=hashlib.sha256(json.dumps(request,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        self.call('resolve-pending',acknowledgement)
        self.assertEqual(self.snapshot()['release']['revision'],'a'*40)
        self.assertEqual(self.snapshot()['ancestry'],'a'*40)
        self.assertIsNone(self.snapshot()['pending'])
    def test_different_target_and_stale_request_refused(self):
        stale=self.request(); self.install()
        self.call('install',encode(stale),data=self.archive.read_bytes(),fail=True)
        failed=self.install('b',fail=True,env={'FAIL_UP':'1'})
        other=self.request('c')
        self.call('retry-release',encode(other),fail=True)
        self.assertEqual(self.snapshot()['pending']['request'],failed)
    def test_retained_data_cannot_be_mistaken_for_fresh_install(self):
        (self.root/'database-present').touch()
        self.install(fail=True)
        self.assertFalse((self.root/'active').exists())
        self.assertIsNone(self.snapshot()['pending'])
    def test_snapshot_failure_never_activates(self):
        for variable in ('FAIL_SNAPSHOT','CORRUPT_COPY','MISSING_BACKEND'):
            with self.subTest(variable=variable):
                if self.snapshot()['release'] is None: self.install()
                active=(self.root/'active').readlink()
                self.install('b',fail=True,env={variable:'1'})
                self.assertEqual((self.root/'active').readlink(),active)
                self.assertEqual(self.snapshot()['ancestry'],'a'*40)
                self.assertIsNone(self.snapshot()['pending'])
    def test_package_edit_replaced_and_baseline_independent_of_host_changes(self):
        self.install(); baseline=self.snapshot()
        (self.root/'active/livekit.yaml').write_text('manual edit')
        (self.root/'active/compose.production.yaml').write_text('malformed: [ compose')
        (self.root/'unrelated-site').write_text('anything')
        (self.root/'.env').write_text(self.env_text+'LIVEKIT_TCP_PORT=7891\n')
        self.assertEqual(self.snapshot(),baseline)
        self.install('b')
        self.assertEqual((self.root/'active/livekit.yaml').read_bytes(),(ROOT/'livekit.yaml').read_bytes())
        self.assertTrue((self.root/'.env').read_text().endswith('LIVEKIT_TCP_PORT=7891\n'))

if __name__ == '__main__': unittest.main()
