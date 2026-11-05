import { execFileSync } from 'node:child_process';
import { parseConventionalCommits } from 'release-please/build/src/commit.js';

const header = /^(feat|fix|perf|docs|ci|chore|build|refactor|style|test|revert)(\([A-Za-z0-9][A-Za-z0-9._/-]*\))?!?: \S.*$/;
const quiet = { debug() {} };

try {
  const [base, head] = process.argv.slice(2);
  if (![base, head].every(sha => /^[a-f0-9]{40}$/.test(sha ?? ''))) {
    throw new Error('Pass the full PR base and head commit SHAs.');
  }
  if ((process.env.PR_BODY ?? '').includes('BEGIN_COMMIT_OVERRIDE')) {
    throw new Error('Release notes use individual commits; PR body commit overrides are unsupported.');
  }
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
  // The base exclusion avoids retroactive linting. Parent count, rather than
  // the subject text, distinguishes actual merges from ordinary commits.
  const shas = git('rev-list', '--no-merges', `${base}..${head}`).trim().split('\n').filter(Boolean);
  const failures = [];
  for (const sha of shas) {
    const message = git('show', '-s', '--format=%B', sha).trimEnd();
    const subject = message.split('\n')[0];
    const parsed = parseConventionalCommits([{ sha, message }], quiet);
    const versionOverride = parsed.some(commit => commit.notes.some(note => note.title === 'RELEASE AS'));
    if (!header.test(subject) || parsed.length === 0 || versionOverride) {
      failures.push(`${sha.slice(0, 7)} ${subject}`);
    }
  }
  if (failures.length) {
    throw new Error(`Invalid incoming commits:\n${failures.join('\n')}\nUse type(scope): description; see docs/runbook.md. Release-As overrides are unsupported.`);
  }
  console.log(`Validated ${shas.length} incoming non-merge commits.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
