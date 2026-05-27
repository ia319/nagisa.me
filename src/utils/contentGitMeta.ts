import path from "node:path";
import { SITE } from "@/config";
import contentGitMetaManifest from "@/generated/contentGitMetaManifest.json";

export type ContentGitCommit = {
  hash: string;
  isoDate: string;
  shortHash: string;
  url?: string;
};

export type ContentGitMeta = {
  firstCommitted?: ContentGitCommit;
  isShallow: boolean;
  lastCommitted?: ContentGitCommit;
  visibleCommitCount: number;
};

type ManifestCommit = {
  hash?: string;
  isoDate?: string;
};

type ManifestEntry = {
  commitCount?: number;
  firstCommitted?: ManifestCommit;
  lastCommitted?: ManifestCommit;
};

type ContentGitMetaManifest = {
  entries?: Record<string, ManifestEntry>;
  version?: number;
};

const UNKNOWN_META: ContentGitMeta = {
  isShallow: false,
  visibleCommitCount: 0,
};

const GIT_HASH_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

const metaCache = new Map<string, ContentGitMeta>();
const manifest = contentGitMetaManifest as ContentGitMetaManifest;

function normalizeGitPath(filePath: string) {
  return filePath.replaceAll("\\", "/").replaceAll(path.sep, "/");
}

function getRepositoryUrl() {
  const repository = SITE.repository.trim().replace(/\/+$/, "");

  if (!repository) return undefined;
  if (/^https?:\/\//i.test(repository)) return repository;
  if (/^[a-z][a-z0-9+.-]*:/i.test(repository)) return undefined;

  return `https://${repository.replace(/^\/+/, "")}`;
}

function getCommitUrl(hash: string) {
  const repositoryUrl = getRepositoryUrl();

  return repositoryUrl ? `${repositoryUrl}/commit/${hash}` : undefined;
}

function getRelativeRepoPath(filePath: string) {
  const repoRoot = process.cwd();
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(repoRoot, filePath);
  const relativePath = path.relative(repoRoot, absolutePath);

  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    return undefined;
  }

  return normalizeGitPath(relativePath);
}

function normalizeCommit(commit: ManifestCommit | undefined) {
  if (!commit?.hash || !commit.isoDate) return undefined;
  if (!GIT_HASH_PATTERN.test(commit.hash)) return undefined;
  if (Number.isNaN(new Date(commit.isoDate).getTime())) return undefined;

  return {
    hash: commit.hash,
    isoDate: commit.isoDate,
    shortHash: commit.hash.slice(0, 7),
    url: getCommitUrl(commit.hash),
  };
}

function countVisibleCommits(
  entry: ManifestEntry,
  firstCommitted: ContentGitCommit | undefined,
  lastCommitted: ContentGitCommit | undefined
) {
  const { commitCount } = entry;

  if (
    typeof commitCount === "number" &&
    Number.isInteger(commitCount) &&
    commitCount >= 0
  ) {
    return commitCount;
  }

  if (firstCommitted && lastCommitted) {
    return firstCommitted.hash === lastCommitted.hash ? 1 : 2;
  }

  return firstCommitted || lastCommitted ? 1 : 0;
}

export function getContentGitMeta(
  filePath: string | undefined
): ContentGitMeta {
  if (!filePath) return UNKNOWN_META;

  const cachedMeta = metaCache.get(filePath);
  if (cachedMeta) return cachedMeta;

  try {
    const relativePath = getRelativeRepoPath(filePath);

    if (!relativePath) return UNKNOWN_META;

    const entry = manifest.entries?.[relativePath];

    if (!entry) return UNKNOWN_META;

    const firstCommitted = normalizeCommit(entry.firstCommitted);
    const lastCommitted = normalizeCommit(entry.lastCommitted);

    const meta = {
      firstCommitted,
      isShallow: false,
      lastCommitted,
      visibleCommitCount: countVisibleCommits(
        entry,
        firstCommitted,
        lastCommitted
      ),
    };

    metaCache.set(filePath, meta);

    return meta;
  } catch {
    metaCache.set(filePath, UNKNOWN_META);

    return UNKNOWN_META;
  }
}
