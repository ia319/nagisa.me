import fs from "node:fs/promises";
import path from "node:path";

const MANIFEST_VERSION = 1;

function createManifestEntry(commits) {
  if (commits.length === 0) return undefined;

  return {
    commitCount: commits.length,
    firstCommitted: commits[commits.length - 1],
    lastCommitted: commits[0],
  };
}

export function createContentGitMetaManifest(fileHistories) {
  const entries = {};

  for (const { commits, relativePath } of fileHistories) {
    const entry = createManifestEntry(commits);

    if (entry) entries[relativePath] = entry;
  }

  return {
    version: MANIFEST_VERSION,
    entries,
  };
}

export async function writeContentGitMetaManifest(manifestPath, manifest) {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
}
