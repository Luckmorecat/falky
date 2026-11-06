"""CI-only source policy and immutable release artifact producer.

Host state is authoritative for the last successful inputs and exact pending
attempt. Documentation commits never hide an earlier undeployed input change.
"""

import json
import os
from pathlib import Path
import re
import subprocess
import sys

import release


def source_inputs():
    revision = release.run('git', 'rev-parse', 'HEAD').strip()
    release.require(os.environ.get('GITHUB_SHA', revision) == revision, 'Checkout differs from workflow source')
    ref = os.environ['GITHUB_REF']
    environment = 'development' if ref == 'refs/heads/master' else 'production'
    release.require(ref == 'refs/heads/master' or re.fullmatch(r'refs/tags/v[0-9][A-Za-z0-9.+-]*', ref),
                    'Releases require master (development) or a v* version tag (production)')
    entries = []
    for entry in release.run('git', 'ls-tree', '-r', '-z', 'HEAD').split('\0'):
        if not entry:
            continue
        _, name = entry.split('\t', 1)
        if name.startswith(('docs/', '.agents/', '.claude/')) or name in (
                'AGENTS.md', 'GLOSSARY.md', 'README.md', 'CHANGELOG.md',
                'version.txt', '.release-please-manifest.json'):
            continue
        # Unknown non-documentation paths invalidate the complete release.
        entries.append(entry)
    inputs = release.digest({'environment': environment, 'files': entries})
    return {'revision': revision, 'ref': ref, 'environment': environment,
            'inputs': dict.fromkeys(release.SERVICES, inputs)}


def plan(snapshot, source):
    release.require(isinstance(snapshot, dict) and set(snapshot) == {
        'version', 'token', 'release', 'ancestry', 'pending', 'legacy'} and snapshot['version'] == 1,
        'Unsupported release snapshot; migrate the instance before automatic deployment')
    release.require(isinstance(snapshot['token'], str) and re.fullmatch('[a-f0-9]{64}', snapshot['token']), 'Invalid baseline token')
    previous = snapshot['ancestry']
    if previous is not None:
        release.require(isinstance(previous, str) and re.fullmatch('[a-f0-9]{40}', previous), 'Invalid ancestry revision')
        result = subprocess.run(['git', 'merge-base', '--is-ancestor', previous, source['revision']], capture_output=True)
        release.require(result.returncode == 0, 'Target does not descend from preserved successful ancestry; use explicit operator recovery')
    pending = snapshot['pending']
    if pending is not None:
        release.valid_request(pending['request'])
        target = pending['request']['release']
        release.require(not pending['recovery'] and all(target[key] == source[key] for key in ('revision', 'ref', 'environment')),
                        'Unresolved different release or recovery attempt; explicit operator resolution is required')
        return {'mode': 'retry', 'source': source, 'request': pending['request']}
    release.require(not snapshot['legacy'], 'Legacy runtime requires explicit operator migration')
    baseline = snapshot['release']
    if baseline is not None:
        release.valid_release(baseline)
    changed = baseline is None or baseline['inputs'] != source['inputs'] or source['environment'] == 'production'
    return {'mode': 'release' if changed else 'skip', 'source': source, 'baseline': snapshot['token']}


def emit(value):
    build = value['mode'] in ('release', 'prepare')
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        for key in release.SERVICES:
            output.write(f'{key}={str(build).lower()}\n')
        output.write(f"changed={str(value['mode'] != 'skip').lower()}\nmode={value['mode']}\nplan={release.encode(value)}\n")


def resolve(value, directory):
    release.require(value['source'] == source_inputs(), 'Resolver source differs from planned source')
    mode = value['mode']
    release.require(mode in ('release', 'prepare', 'retry'), 'No release was planned')
    for key in release.SERVICES:
        release.require(os.environ[key.upper() + '_RESULT'] == ('skipped' if mode == 'retry' else 'success'),
                        'Both requested builds must succeed; only an exact retry may skip publishing')
    if mode == 'retry':
        release.valid_request(value['request'])
        release.require(all(value['request']['release'][key] == value['source'][key]
                            for key in ('revision', 'ref', 'environment')), 'Retry target differs from planned source')
        return 'retry-release ' + release.encode(value['request'])
    images = {'livekit': release.LIVEKIT}
    for key, repository in release.REPOSITORIES.items():
        image_digest = os.environ[key.upper() + '_DIGEST']
        release.require(re.fullmatch('sha256:[a-f0-9]{64}', image_digest), 'Build did not produce an immutable digest')
        images[key] = repository + '@' + image_digest
    directory.mkdir(mode=0o700)
    metadata = release.package(Path(__file__).resolve().parent, directory / 'runtime.tar')
    manifest = {'version': 1, **value['source'], 'package': metadata, 'images': images}
    release.valid_release(manifest)
    release.atomic_write(directory / 'manifest.json', manifest)
    if mode == 'prepare':
        return ''
    request = {'version': 1, 'baseline': value['baseline'], 'release': manifest}
    release.valid_request(request)
    return 'deploy-release ' + release.encode(request)


def main():
    os.umask(0o077)
    args = sys.argv[1:]
    if len(args) == 2 and args[0] == 'plan':
        emit(plan(json.loads(Path(args[1]).read_text()), source_inputs()))
    elif args == ['prepare']:
        source = source_inputs()
        release.require(os.environ['GITHUB_EVENT_NAME'] == 'workflow_dispatch' and
                        os.environ['PREPARE_ENVIRONMENT'] == source['environment'],
                        'Prepare environment must match master (development) or the version tag (production)')
        emit({'mode': 'prepare', 'source': source})
    elif len(args) == 2 and args[0] == 'resolve':
        print(resolve(release.decode(os.environ['RELEASE_PLAN']), Path(args[1])))
    else:
        raise ValueError('Usage: ci-plan.py plan snapshot.json | prepare | resolve artifact-directory')


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError) as error:
        sys.exit(str(error))
