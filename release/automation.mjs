import { Manifest } from 'release-please';
import './policy.mjs';

export async function publishAndUpdate(github) {
  const publication = await Manifest.fromManifest(github, 'master');
  await publication.createReleases();
  // Refresh discovery after publication; Release Please owns retry state.
  const proposal = await Manifest.fromManifest(github, 'master');
  await proposal.createPullRequests();
}
