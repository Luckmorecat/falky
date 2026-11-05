import { GitHub } from 'release-please';
import { publishAndUpdate } from './automation.mjs';

// Publication intentionally has no dependency on development deployment.
// Release Please owns PR discovery, merge SHAs, tags, labels and retry state.
try {
  if (process.env.GITHUB_REPOSITORY !== 'Luckmorecat/falky' ||
      process.env.GITHUB_REF !== 'refs/heads/master') {
    throw new Error('Releases must run on Luckmorecat/falky master.');
  }
  if (!process.env.RELEASE_TOKEN) {
    throw new Error('The repository GitHub App installation token is required.');
  }
  const github = await GitHub.create({
    owner: 'Luckmorecat',
    repo: 'falky',
    token: process.env.RELEASE_TOKEN,
  });
  await publishAndUpdate(github);
} catch (error) {
  // Do not dump SDK request objects: they can contain authorization headers.
  console.error(error.message);
  process.exitCode = 1;
}
