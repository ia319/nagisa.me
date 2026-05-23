import { execFileSync } from "node:child_process";
import path from "node:path";
import { SITE } from "@/config";

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

const UNKNOWN_META: ContentGitMeta = {
  isShallow: false,
  visibleCommitCount: 0,
};

const metaCache = new Map<string, ContentGitMeta>();
let gitStateCache: { isShallow: boolean; repoRoot: string } | undefined;

function normalizeGitPath(filePath: string) {
  return filePath.replaceAll(path.sep, "/");
}

function getCommitUrl(hash: string) {
  const repository = SITE.repository.trim().replace(/\/$/, "");

  if (!repository) return undefined;

  const repositoryUrl = /^https?:\/\//i.test(repository)
    ? repository
    : `https://${repository}`;

  return `${repositoryUrl}/commit/${hash}`;
}

function getSafeDirectoryArg(repoRoot: string) {
  return `safe.directory=${normalizeGitPath(repoRoot)}`;
}

function runGit(args: string[], repoRoot = process.cwd()) {
  return execFileSync("git", ["-c", getSafeDirectoryArg(repoRoot), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function getGitState() {
  if (gitStateCache) return gitStateCache;

  const initialRoot = process.cwd();
  const repoRoot = runGit(["rev-parse", "--show-toplevel"], initialRoot);
  const isShallow =
    runGit(["rev-parse", "--is-shallow-repository"], repoRoot) === "true";

  gitStateCache = { isShallow, repoRoot };

  return gitStateCache;
}

function parseCommitLine(line: string): ContentGitCommit | undefined {
  const [hash, isoDate] = line.split("\t");

  if (!hash || !isoDate || !/^[0-9a-f]{40}$/i.test(hash)) return undefined;
  if (Number.isNaN(new Date(isoDate).getTime())) return undefined;

  return {
    hash,
    isoDate,
    shortHash: hash.slice(0, 7),
    url: getCommitUrl(hash),
  };
}

function getRelativeRepoPath(filePath: string, repoRoot: string) {
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

export function getContentGitMeta(
  filePath: string | undefined
): ContentGitMeta {
  if (!filePath) return UNKNOWN_META;

  const cachedMeta = metaCache.get(filePath);
  if (cachedMeta) return cachedMeta;

  try {
    const { isShallow, repoRoot } = getGitState();
    const relativePath = getRelativeRepoPath(filePath, repoRoot);

    if (!relativePath) return UNKNOWN_META;

    const output = runGit(
      ["log", "--follow", "--format=%H%x09%cI", "--", relativePath],
      repoRoot
    );
    const commits = output
      .split(/\r?\n/)
      .map(parseCommitLine)
      .filter(commit => commit !== undefined);
    const lastCommitted = commits[0];
    const firstCommitted = isShallow ? undefined : commits[commits.length - 1];

    const meta = {
      firstCommitted,
      isShallow,
      lastCommitted,
      visibleCommitCount: commits.length,
    };

    metaCache.set(filePath, meta);

    return meta;
  } catch {
    metaCache.set(filePath, UNKNOWN_META);

    return UNKNOWN_META;
  }
}
