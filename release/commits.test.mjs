import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const validator = fileURLToPath(new URL('./validate-commits.mjs', import.meta.url));

test('validate only incoming individual commits, accepting merge commits and bot releases', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'falky-commits-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const commit = message => {
    git('commit', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const validate = (base, head, body = '') => spawnSync(process.execPath, [validator, base, head], {
    cwd, encoding: 'utf8', env: { ...process.env, PR_BODY: body },
  });
  try {
    git('init', '-b', 'master');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    const base = commit('old nonconventional history stays valid');
    git('switch', '-c', 'feature');
    commit('feat(web): add a feature\n\nBREAKING CHANGE: clients must upgrade');
    commit('fix(api)!: change field');
    commit('fix(UP-123): repair issue');
    commit('perf(server/http): reduce allocations');
    const bot = commit('chore(master): release 1.0.0');
    assert.equal(validate(base, bot).status, 0);
    git('switch', 'master');
    commit('chore: branch divergence');
    git('merge', '--no-ff', 'feature', '-m', 'Merge feature branch');
    assert.equal(validate(base, git('rev-parse', 'HEAD')).status, 0);
    const invalid = commit('implement unstructured change');
    const result = validate(base, invalid);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /implement unstructured change/);
    for (const message of ['unknown: unsupported type', 'fix: ',
      'fix: repair\n\nRelease-As: 9.0.0', 'fix: repair\n\nRelease-As #9.0.0']) {
      assert.equal(validate(invalid, commit(message)).status, 1);
      git('reset', '--hard', invalid);
    }
    assert.equal(validate(base, bot, 'BEGIN_COMMIT_OVERRIDE\nfeat!: bypass commits\nEND_COMMIT_OVERRIDE').status, 1);
    assert.equal(validate('--all', bot).status, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
