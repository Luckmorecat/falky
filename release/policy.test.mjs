import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Manifest, setLogger } from 'release-please';
import { publishAndUpdate } from './automation.mjs';
import './policy.mjs';

setLogger({ debug() {}, info() {}, warn() {}, error() {} });

// Only the GitHub boundary is substituted. Manifest discovery, configuration,
// parsing, version calculation, notes and file updaters are the pinned library.
const shaFor = message => createHash('sha1').update(message).digest('hex');

function githubFor(messages, released = false, parents = new Map()) {
  return {
    repository: { owner: 'Luckmorecat', repo: 'falky' },
    async getFileJson(path) {
      if (path === '.release-please-manifest.json') return released ? { '.': '1.2.3' } : {};
      return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url)));
    },
    async *releaseIterator() {
      if (released) yield { tagName: 'v1.2.3', sha: 'previous-release', notes: '' };
    },
    async *tagIterator() {},
    getGitHubApi() {
      return { octokit: { git: { async getCommit({ commit_sha }) {
        return { data: { parents: parents.get(commit_sha) ?? [{}] } };
      } } } };
    },
    async *mergeCommitIterator(_branch, { maxResults }) {
      for (const message of messages.slice(0, maxResults)) {
        yield typeof message === 'string'
          ? { sha: shaFor(message), message, files: ['server/main.go'] }
          : message;
      }
      if (released) yield { sha: 'previous-release', message: 'chore(master): release 1.2.3' };
    },
  };
}

test('first release is 1.0.0 and includes individual historical commits past the default search limit', async () => {
  const github = githubFor([
    'feat!: latest feature',
    ...Array.from({ length: 510 }, () => 'Merge pull request #1 from feature'),
    'fix: oldest historical fix',
  ]);
  const manifest = await Manifest.fromManifest(github, 'master');
  const [pr] = await manifest.buildPullRequests();
  assert.equal(pr.version.toString(), '1.0.0');
  assert.match(pr.body.toString(), /oldest historical fix/);
  assert.match(pr.body.toString(), /latest feature/);
  const updates = new Map(pr.updates.map(update => [update.path, update.updater.updateContent('')]));
  assert.equal(updates.get('version.txt'), '1.0.0\n');
  assert.match(updates.get('CHANGELOG.md'), /oldest historical fix/);
  assert.equal(JSON.parse(updates.get('.release-please-manifest.json'))['.'], '1.0.0');
});

test('semantic and breaking merge bodies cannot create or inflate releases', async () => {
  const mergeMessages = [
    'Merge pull request #42 from feature\n\nfeat!: title would incorrectly bump major',
    'feat: custom merge subject\n\nBREAKING CHANGE: merge body is not a semantic commit',
  ];
  const parents = new Map(mergeMessages.map(message => [shaFor(message), [{}, {}]]));
  const onlyMerges = await Manifest.fromManifest(githubFor(mergeMessages, true, parents), 'master');
  assert.deepEqual(await onlyMerges.buildPullRequests(), []);
  const mixed = await Manifest.fromManifest(githubFor(['fix: individual repair', ...mergeMessages], true, parents), 'master');
  const [pr] = await mixed.buildPullRequests();
  assert.equal(pr.version.toString(), '1.2.4');
  assert.match(pr.body.toString(), /individual repair/);
  for (const message of mergeMessages) assert.ok(!pr.body.toString().includes(`/commit/${shaFor(message)}`));
});

test('root commits and remote single-parent commits survive merge-like words and identical subjects', async () => {
  const messages = [
    { sha: 'd'.repeat(40), message: 'feat: initial root', files: ['server/main.go'] },
    { sha: 'e'.repeat(40), message: 'fix: Merge pull request is ordinary text', files: ['server/main.go'] },
    { sha: 'f'.repeat(40), message: 'fix: Merge pull request is ordinary text', files: ['server/main.go'] },
  ];
  const parents = new Map(messages.map(commit => [commit.sha, commit.sha.startsWith('d') ? [] : [{}]]));
  const github = githubFor(messages, false, parents);
  const [pr] = await (await Manifest.fromManifest(github, 'master')).buildPullRequests();
  for (const commit of messages) assert.ok(pr.body.toString().includes(`/commit/${commit.sha}`));
});

test('parent lookups are cached for multiple semantic fragments from the same commit', async () => {
  const message = 'fix: primary repair\n\nfeat: secondary feature';
  const github = githubFor([message], true);
  const calls = [];
  github.getGitHubApi = () => ({ octokit: { git: { async getCommit({ commit_sha }) {
    calls.push(commit_sha);
    return { data: { parents: [{}] } };
  } } } });
  const [pr] = await (await Manifest.fromManifest(github, 'master')).buildPullRequests();
  assert.match(pr.body.toString(), /primary repair/);
  assert.match(pr.body.toString(), /secondary feature/);
  assert.equal(pr.version.toString(), '1.3.0');
  assert.deepEqual(calls, [shaFor(message)]);
});

for (const failure of ['unavailable', 'invalid']) {
  test(`${failure} Git parent metadata prevents a guessed proposal`, async () => {
    const github = githubFor(['fix: do not guess'], true);
    github.getGitHubApi = () => ({ octokit: { git: { async getCommit() {
      if (failure === 'unavailable') throw new Error('parent lookup unavailable');
      return { data: {} };
    } } } });
    const manifest = await Manifest.fromManifest(github, 'master');
    await assert.rejects(manifest.createPullRequests(), /parent lookup unavailable|Missing Git parents/);
  });
}

test('first release notes match all 32 historical individual source SHAs, excluding six semantic merges', async () => {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const fields = execFileSync('git', ['log', 'd2563f0ce0499766654c73c50643a9f55c857ce6',
    '--format=%H%x00%P%x00%B%x00'], { cwd, encoding: 'utf8' }).split('\0');
  const history = [];
  const parents = new Map();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const sha = fields[index].trim();
    parents.set(sha, fields[index + 1].split(' ').filter(Boolean));
    history.push({ sha, message: fields[index + 2], files: [] });
  }
  // Independent expectation from the actual Git graph and historical headers,
  // not from Release Please's parser or the policy under test.
  const expected = history.filter(commit => parents.get(commit.sha).length <= 1 &&
    /^(feat|fix|perf)(\((?!ci\))[^)]+\))?!?: /.test(commit.message));
  assert.equal(expected.length, 32);
  const [pr] = await (await Manifest.fromManifest(githubFor(history, false, parents), 'master')).buildPullRequests();
  assert.equal(pr.version.toString(), '1.0.0');
  const actual = [...pr.body.toString().matchAll(/\/commit\/([a-f0-9]{40})/g)].map(match => match[1]);
  assert.equal(actual.length, 32);
  assert.deepEqual(new Set(actual), new Set(expected.map(commit => commit.sha)));
  for (const sha of [
    '9c233d314e74fb48dbd8e368d6ee4f7e1c6a2ab9', '967379331608b17e4a4d19c8e5d79cb1c556605f',
    '5331a4d4f96381c43439f4d8837936809817032b', '0cb159ba7476743fe5051d8c9a8ce806a552238c',
    '16f912de867819febd9b7847b755443899f3aef2', '53e3fa7c818910bcda7f03e6224813b10581856f',
  ]) assert.ok(!actual.includes(sha));
});

for (const [message, expected] of [
  ['fix(server): restore connection', '1.2.4'],
  ['perf(web): reduce render work', '1.2.4'],
  ['fix(deps): update the LiveKit runtime dependency', '1.2.4'],
  ['feat(voice): add speaking indicator', '1.3.0'],
  ['fix(api)!: remove obsolete response field', '2.0.0'],
  ['feat(api): change response\n\nBREAKING CHANGE: old clients must upgrade', '2.0.0'],
  ['chore(deps): update test tooling', undefined],
  ['build: update compiler', undefined],
]) {
  test(`${message.split('\n')[0]} proposes ${expected ?? 'no release'}`, async () => {
    const manifest = await Manifest.fromManifest(githubFor([message], true), 'master');
    const [pr] = await manifest.buildPullRequests();
    assert.equal(pr?.version.toString(), expected);
  });
}

test('publication targets the merged release PR SHA even after master advances', async () => {
  const github = githubFor(['fix: ship a repair']);
  const manifest = await Manifest.fromManifest(github, 'master');
  const [pr] = await manifest.buildPullRequests();
  github.pullRequestIterator = async function* () {
    yield {
      number: 42,
      sha: 'b'.repeat(40),
      mergeCommitOid: 'b'.repeat(40),
      title: pr.title.toString(),
      body: pr.body.toString(),
      baseBranchName: 'master',
      headBranchName: pr.headRefName,
      labels: ['autorelease: pending'],
      files: pr.updates.map(update => update.path),
    };
  };
  const [release] = await manifest.buildReleases();
  assert.equal(release.sha, 'b'.repeat(40));
  assert.equal(release.tag.toString(), 'v1.0.0');
  assert.match(release.notes, /ship a repair/);
});

test('CI and documentation maintenance cannot trigger or inflate a release', async () => {
  const maintenance = ['perf(ci): faster checks', 'perf(CI): quicker tools', 'feat(ci)!: replace CI', 'docs!: rewrite instructions'];
  const manifest = await Manifest.fromManifest(githubFor(maintenance, true), 'master');
  assert.deepEqual(await manifest.buildPullRequests(), []);
  const mixed = await Manifest.fromManifest(githubFor(['fix(deploy): repair health probe', ...maintenance], true), 'master');
  const [pr] = await mixed.buildPullRequests();
  assert.equal(pr.version.toString(), '1.2.4');
  assert.doesNotMatch(pr.body.toString(), /faster checks|replace CI|rewrite instructions/);
});

test('post-merge PR body edits cannot replace or suppress canonical individual commit semantics', async () => {
  const mergedPr = {
    number: 42, state: 'MERGED', body: 'Reviewed ordinary pull request',
    mergeCommitOid: 'b'.repeat(40),
  };
  const commit = {
    sha: 'a'.repeat(40), message: 'fix: validated individual repair',
    files: ['server/main.go'], pullRequest: mergedPr,
  };
  const github = githubFor([commit], true);
  const propose = async () => (await Manifest.fromManifest(github, 'master')).buildPullRequests();
  const assertCanonical = async () => {
    const [pr] = await propose();
    assert.equal(pr.version.toString(), '1.2.4');
    assert.match(pr.body.toString(), /validated individual repair/);
    assert.doesNotMatch(pr.body.toString(), /mutable PR override/);
  };
  await assertCanonical();
  for (const override of [
    'feat!: mutable PR override\n\nRelease-As: 9.0.0',
    'docs: mutable PR override',
    'nonconventional mutable PR override',
  ]) {
    mergedPr.body = `BEGIN_COMMIT_OVERRIDE\n${override}\nEND_COMMIT_OVERRIDE`;
    await assert.rejects(propose(), /PR body commit overrides are unsupported \(PR #42, commit a{40}\).*Remove the override/);
    // Inspection must not mutate discovery metadata or the canonical message.
    assert.equal(commit.pullRequest, mergedPr);
    assert.equal(mergedPr.mergeCommitOid, 'b'.repeat(40));
    assert.match(mergedPr.body, /BEGIN_COMMIT_OVERRIDE/);
    assert.equal(commit.message, 'fix: validated individual repair');
  }
  mergedPr.body = 'Removed unsupported override after merge';
  await assertCanonical();
});

test('overrides edited onto already-released history do not block later proposals', async () => {
  const github = githubFor([], true);
  const oldBody = { number: 7, body: 'BEGIN_COMMIT_OVERRIDE\nfeat!: old mutable override\nEND_COMMIT_OVERRIDE' };
  github.mergeCommitIterator = async function* () {
    yield { sha: 'a'.repeat(40), message: 'fix: new repair', files: ['server/main.go'] };
    yield { sha: 'previous-release', message: 'Merge release PR', pullRequest: oldBody };
    yield { sha: 'b'.repeat(40), message: 'fix: previously released repair', pullRequest: oldBody };
  };
  const [pr] = await (await Manifest.fromManifest(github, 'master')).buildPullRequests();
  assert.equal(pr.version.toString(), '1.2.4');
  assert.match(pr.body.toString(), /new repair/);
  assert.doesNotMatch(pr.body.toString(), /old mutable override|previously released repair/);
});

test('one rolling PR updates on maintenance; publication retries and then proposes only later commits', async () => {
  const messages = ['fix: accumulated repair'];
  const github = githubFor(messages);
  const prs = [];
  const releases = [];
  let updates = 0;
  let merged = false;
  let failPublication = true;
  const readConfig = github.getFileJson;
  const oldHistory = github.mergeCommitIterator;
  github.getFileJson = async path => path === '.release-please-manifest.json' && merged
    ? { '.': '1.0.0' } : readConfig(path);
  github.mergeCommitIterator = async function* (...args) {
    if (merged) {
      yield { sha: 'c'.repeat(40), message: 'fix: later master repair', files: ['server/main.go'] };
      yield { sha: 'b'.repeat(40), message: 'Merge release PR', pullRequest: prs[0] };
    }
    yield* oldHistory(...args);
  };
  github.pullRequestIterator = async function* (_branch, state) {
    yield* prs.filter(pr => pr.state === state);
  };
  github.releaseIterator = async function* () { yield* releases; };
  github.createPullRequest = async pr => {
    const created = { ...pr, number: prs.length + 1, state: 'OPEN' };
    prs.push(created);
    return created;
  };
  github.updatePullRequest = async (number, pr, branch) => {
    assert.equal(branch, 'master');
    updates++;
    const existing = prs.find(item => item.number === number);
    existing.body = pr.body.toString();
    existing.title = pr.title.toString();
    return existing;
  };
  github.createRelease = async release => {
    if (failPublication) throw new Error('temporary API outage');
    const created = { ...release, tagName: release.tag.toString(), url: 'https://example.invalid/release' };
    releases.push(created);
    return created;
  };
  github.commentOnIssue = async () => {};
  github.removeIssueLabels = async (labels, number) => {
    const pr = prs.find(item => item.number === number);
    pr.labels = pr.labels.filter(label => !labels.includes(label));
  };
  github.addIssueLabels = async (labels, number) => prs.find(item => item.number === number).labels.push(...labels);

  await publishAndUpdate(github);
  assert.equal(prs.length, 1);
  const originalBody = prs[0].body;
  messages.unshift('docs: update operator instructions');
  await publishAndUpdate(github);
  assert.equal(prs.length, 1);
  assert.equal(updates, 1);
  assert.equal(prs[0].body, originalBody);

  merged = true;
  Object.assign(prs[0], { state: 'MERGED', sha: 'b'.repeat(40), mergeCommitOid: 'b'.repeat(40) });
  await assert.rejects(publishAndUpdate(github), /temporary API outage/);
  assert.equal(prs.length, 1);
  failPublication = false;
  await publishAndUpdate(github);
  assert.equal(releases.length, 1);
  assert.equal(releases[0].tagName, 'v1.0.0');
  assert.equal(releases[0].sha, 'b'.repeat(40));
  assert.equal(prs.length, 2);
  assert.match(prs[1].body, /1\.0\.1/);
  assert.match(prs[1].body, /later master repair/);
  assert.doesNotMatch(prs[1].body, /accumulated repair/);
  await publishAndUpdate(github);
  assert.equal(releases.length, 1);
  assert.equal(prs.length, 2);
});
