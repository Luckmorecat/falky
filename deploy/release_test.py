"""The public runtime artifact/protocol contract (no Docker required)."""
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('release', ROOT / 'release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

class PackageTests(unittest.TestCase):
    def test_producer_is_reproducible_and_contains_only_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            outputs = [Path(temporary) / name for name in ('one.tar', 'two.tar')]
            metadata = []
            for path in outputs:
                result = subprocess.run([sys.executable, str(ROOT / 'release.py'), 'package', str(path)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                metadata.append(json.loads(result.stdout))
            self.assertEqual(outputs[0].read_bytes(), outputs[1].read_bytes())
            self.assertEqual(metadata[0], metadata[1])
            with tarfile.open(outputs[0]) as archive:
                names = archive.getnames()
                self.assertIn('package.json', names)
                self.assertIn('compose.production.yaml', names)
                self.assertNotIn('compose.yaml', names)
                self.assertNotIn('Caddyfile', names)
                self.assertNotIn('WebCaddyfile', names)
                self.assertFalse(any(name.startswith(('edge/', 'systemd/')) for name in names))
                self.assertFalse(any('edge' in name or '.env' in name or '_test' in name for name in names))

    def test_archive_paths_links_duplicates_and_inventory_tampering_are_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'runtime.tar'
            release.package(ROOT,path)
            original=path.read_bytes()
            for attack in ('path','symlink','duplicate','inventory','oversize','unknown'):
                with self.subTest(attack=attack):
                    output=io.BytesIO()
                    with tarfile.open(fileobj=io.BytesIO(original),mode='r:') as source, tarfile.open(fileobj=output,mode='w',format=tarfile.USTAR_FORMAT) as target:
                        for item in source:
                            data=source.extractfile(item).read()
                            if item.name == 'livekit.yaml':
                                if attack == 'path': item.name='../outside'
                                elif attack == 'symlink': item.type=tarfile.SYMTYPE; item.linkname='/etc/passwd'; item.size=0
                                elif attack == 'inventory': data=b'corrupt'; item.size=len(data)
                                elif attack == 'unknown': item.name='unexpected.py'
                                elif attack == 'oversize': data=b'x'*(release.MAX_PACKAGE+1); item.size=len(data)
                            target.addfile(item,io.BytesIO(data))
                            if attack == 'duplicate' and item.name == 'livekit.yaml': target.addfile(item,io.BytesIO(data))
                    data=output.getvalue(); expected={'version':1,'sha256':release.sha(data),'size':len(data)}
                    with self.assertRaises((ValueError,tarfile.TarError)):
                        release.unpack(data,expected)
                    self.assertFalse((Path(temporary)/'outside').exists())
    def test_wrong_digest_or_truncated_archive_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'runtime.tar'; metadata=release.package(ROOT,path)
            with self.assertRaises(ValueError): release.unpack(path.read_bytes()[:-1],metadata)
            with self.assertRaises(ValueError): release.unpack(b'x'*metadata['size'],metadata)

if __name__ == '__main__': unittest.main()
