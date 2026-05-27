import { execFileSync } from "node:child_process";
import path from "node:path";

export const CONTENT_ROOTS = ["src/data/blog", "src/data/pages"];

const GIT_HASH_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function normalizeGitPath(filePath) {
  return filePath.replaceAll("\\", "/");
}

function getSafeContentPath(relativePath) {
  const normalizedInput = normalizeGitPath(relativePath).replace(/^\.\/+/, "");
  const normalizedPath = path.posix.normalize(normalizedInput);

  if (
    !normalizedPath ||
    normalizedPath !== normalizedInput ||
    normalizedPath === "." ||
    normalizedPath === ".." ||
    normalizedPath.startsWith("../") ||
    normalizedPath.startsWith("/")
  ) {
    return undefined;
  }

  return CONTENT_ROOTS.some(
    root => normalizedPath === root || normalizedPath.startsWith(`${root}/`)
  )
    ? normalizedPath
    : undefined;
}

function getSafeDirectoryArg(repoRoot) {
  return `safe.directory=${normalizeGitPath(repoRoot)}`;
}

function runGit(args, repoRoot = process.cwd()) {
  return execFileSync("git", ["-c", getSafeDirectoryArg(repoRoot), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function isMarkdownContentPath(relativePath) {
  return /\.(?:md|mdx)$/i.test(relativePath);
}

function parseCommitLine(line) {
  const [hash, isoDate] = line.split("\t");

  if (!hash || !isoDate || !GIT_HASH_PATTERN.test(hash)) return undefined;
  if (Number.isNaN(new Date(isoDate).getTime())) return undefined;

  return { hash, isoDate };
}

export function getRepoRoot(cwd = process.cwd()) {
  return runGit(["rev-parse", "--show-toplevel"], cwd);
}

export function isShallowRepository(repoRoot) {
  return runGit(["rev-parse", "--is-shallow-repository"], repoRoot) === "true";
}

export function listTrackedContentFiles(repoRoot) {
  const output = runGit(["ls-files", "-z", "--", ...CONTENT_ROOTS], repoRoot);

  return output
    .split("\0")
    .map(getSafeContentPath)
    .filter(relativePath => relativePath !== undefined)
    .filter(isMarkdownContentPath)
    .sort((a, b) => a.localeCompare(b));
}

export function getFileCommitHistory(repoRoot, relativePath) {
  const safePath = getSafeContentPath(relativePath);

  if (!safePath) return [];

  const output = runGit(
    ["log", "--follow", "--format=%H%x09%cI", "--", safePath],
    repoRoot
  );

  if (!output) return [];

  return output
    .split(/\r?\n/)
    .map(parseCommitLine)
    .filter(commit => commit !== undefined);
}
