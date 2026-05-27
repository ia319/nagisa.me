#!/usr/bin/env node

import path from "node:path";
import {
  getFileCommitHistory,
  getRepoRoot,
  isShallowRepository,
  listTrackedContentFiles,
} from "./content-git-meta/git-history.mjs";
import {
  createContentGitMetaManifest,
  writeContentGitMetaManifest,
} from "./content-git-meta/manifest.mjs";

const MANIFEST_PATH = "src/generated/contentGitMetaManifest.json";

const repoRoot = getRepoRoot();

if (isShallowRepository(repoRoot)) {
  process.stderr.write(
    "Content Git metadata manifest requires a full Git clone. Generate it locally after committing content changes.\n"
  );
  process.exit(1);
}

const trackedFiles = listTrackedContentFiles(repoRoot);
const fileHistories = trackedFiles.map(relativePath => ({
  relativePath,
  commits: getFileCommitHistory(repoRoot, relativePath),
}));
const manifest = createContentGitMetaManifest(fileHistories);

await writeContentGitMetaManifest(path.join(repoRoot, MANIFEST_PATH), manifest);

process.stdout.write(
  `Wrote ${MANIFEST_PATH} with ${Object.keys(manifest.entries).length} entries.\n`
);
