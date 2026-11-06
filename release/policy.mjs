import { registerPlugin, registerReleaseType } from 'release-please';
import { ManifestPlugin } from 'release-please/build/src/plugin.js';
import { Simple } from 'release-please/build/src/strategies/simple.js';

class IndividualCommitPolicy extends ManifestPlugin {
  async preconfigure(strategies, commitsByPath) {
    // Incoming checks cannot prevent a merged PR body from being edited later.
    // This hook sees unreleased raw commits before upstream override parsing;
    // reject rather than mutate their messages or release-discovery metadata.
    for (const commits of Object.values(commitsByPath)) {
      for (const commit of commits) {
        if (commit.pullRequest?.body.includes('BEGIN_COMMIT_OVERRIDE')) {
          throw new Error(`PR body commit overrides are unsupported (PR #${commit.pullRequest.number}, commit ${commit.sha}). Remove the override from the PR body and rerun Release Please.`);
        }
      }
    }
    return strategies;
  }
}

registerPlugin('falky-commit-policy', options => new IndividualCommitPolicy(
  options.github, options.targetBranch, options.repositoryConfig, options.logger));

class Falky extends Simple {
  parentCounts = new Map();

  async postProcessCommits(commits) {
    // Hiding changelog sections alone still lets maintenance inflate a mixed
    // release's version. Remove it before both versioning and note generation.
    const accepted = [];
    for (const commit of commits) {
      if (['ci', 'docs'].includes(commit.type) ||
          ['ci', 'docs'].includes(commit.scope?.toLowerCase())) continue;
      // The upstream parser can interpret a PR title inside a merge body.
      // Resolve real parent identity by immutable SHA, including commits that
      // reached master after checkout. Keep raw history intact for discovery.
      if (!this.parentCounts.has(commit.sha)) {
        const { data } = await this.github.getGitHubApi().octokit.git.getCommit({
          ...this.repository, commit_sha: commit.sha,
        });
        if (!Array.isArray(data.parents)) {
          throw new Error(`Missing Git parents for ${commit.sha}; refusing to guess release semantics.`);
        }
        this.parentCounts.set(commit.sha, data.parents.length);
      }
      if (this.parentCounts.get(commit.sha) <= 1) accepted.push(commit);
    }
    return accepted;
  }
}

registerReleaseType('falky', options => new Falky(options));
