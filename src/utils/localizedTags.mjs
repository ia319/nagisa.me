import { resolveTranslationSource } from "../content/translationContract.mjs";
import { slugifyStr } from "./slugify.mjs";

/**
 * @typedef {Readonly<{baseId: string, locale: string, tags: readonly string[], translation?: {sourceLocale: string}}>} LocalizedTagContent
 * @typedef {Readonly<{locale: string, tag: string, slug: string}>} LocalizedTag
 * @typedef {{code: "duplicate-tags" | "missing-source" | "source-is-target" | "tag-count-mismatch" | "ambiguous-mapping", message: string, baseId?: string, locale?: string}} TagDiagnostic
 * @typedef {{members: LocalizedTag[], ambiguous: boolean}} TagGroup
 * @typedef {{tags: LocalizedTag[], groups: Map<string, TagGroup>, diagnostics: TagDiagnostic[]}} TagRelations
 */

/**
 * Build tag relationships from an explicitly supplied localized content snapshot.
 * Callers select drafts or public posts; this module never reads content or logs.
 * @param {readonly LocalizedTagContent[]} contents Validated content identities and ordered tags.
 * @returns {TagRelations} Tag routes, connected language groups, and non-fatal diagnostics.
 * @throws {Error} When content identities repeat or tags produce invalid or duplicate routes.
 */
export function buildTagRelations(contents) {
  const ordered = [...contents].sort((a, b) => {
    const left = JSON.stringify([a.baseId, a.locale]);
    const right = JSON.stringify([b.baseId, b.locale]);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const identities = new Set();
  const invalid = new Set();
  /** @type {Map<string, LocalizedTag>} */
  const tags = new Map();
  /** @type {Map<string, Set<string>>} */
  const edges = new Map();
  const routes = new Map();
  /** @type {TagDiagnostic[]} */
  const diagnostics = [];

  for (const content of ordered) {
    const identity = JSON.stringify([content.baseId, content.locale]);
    if (identities.has(identity)) {
      throw new Error(`Duplicate localized tag content: ${identity}`);
    }
    identities.add(identity);
    const seen = new Set();
    for (const tag of content.tags) {
      if (typeof tag !== "string" || tag.trim().length === 0) {
        throw new Error(`Empty or invalid tag in ${identity}`);
      }
      if (seen.has(tag)) {
        invalid.add(content);
        diagnostics.push({
          code: "duplicate-tags",
          baseId: content.baseId,
          locale: content.locale,
          message: `Duplicate tag ${JSON.stringify(tag)} in ${identity}; skip positional relationships`,
        });
      }
      seen.add(tag);
      const key = JSON.stringify([content.locale, tag]);
      if (tags.has(key)) continue;
      const slug = slugifyStr(tag);
      if (!slug || slug === "." || slug === ".." || /[\s/\\?#%]/u.test(slug)) {
        throw new Error(
          `Invalid tag route for ${key}: ${JSON.stringify(slug)}`
        );
      }
      const route = `/${content.locale}/tags/${encodeURIComponent(slug)}/`;
      const previous = routes.get(route);
      if (previous && previous !== tag) {
        throw new Error(
          `Tag route collision at ${route}: ${JSON.stringify(previous)} and ${JSON.stringify(tag)}`
        );
      }
      routes.set(route, tag);
      tags.set(key, { locale: content.locale, tag, slug });
      edges.set(key, new Set());
    }
  }

  for (const content of ordered) {
    const source = resolveTranslationSource(content, ordered);
    if (source.status === "not-translated") continue;
    if (source.status !== "resolved") {
      diagnostics.push({
        code: source.status,
        baseId: content.baseId,
        locale: content.locale,
        message: `Cannot pair tags for ${content.baseId} (${content.locale}): ${source.status} (${source.sourceLocale})`,
      });
      continue;
    }
    if (content.tags.length !== source.source.tags.length) {
      diagnostics.push({
        code: "tag-count-mismatch",
        baseId: content.baseId,
        locale: content.locale,
        message: `Tag count mismatch for ${content.baseId}: ${source.sourceLocale} has ${source.source.tags.length}, ${content.locale} has ${content.tags.length}`,
      });
      continue;
    }
    if (invalid.has(content) || invalid.has(source.source)) continue;
    for (const [index, tag] of content.tags.entries()) {
      const from = JSON.stringify([
        source.sourceLocale,
        source.source.tags[index],
      ]);
      const to = JSON.stringify([content.locale, tag]);
      edges.get(from).add(to);
      edges.get(to).add(from);
    }
  }

  /** @type {Map<string, TagGroup>} */
  const groups = new Map();
  const keys = [...tags.keys()].sort();
  for (const key of keys) {
    if (groups.has(key)) continue;
    const connected = new Set([key]);
    for (const current of connected) {
      for (const neighbor of edges.get(current)) connected.add(neighbor);
    }
    const members = [...connected].sort().map(member => tags.get(member));
    const ambiguous =
      new Set(members.map(member => member.locale)).size !== members.length;
    const group = { members, ambiguous };
    for (const member of connected) groups.set(member, group);
    if (ambiguous) {
      diagnostics.push({
        code: "ambiguous-mapping",
        message: `Ambiguous tag relationship: ${members.map(member => `${member.locale}: ${JSON.stringify(member.tag)}`).join("; ")}`,
      });
    }
  }
  return { tags: keys.map(key => tags.get(key)), groups, diagnostics };
}

/**
 * Resolve a unique tag translation without guessing through ambiguous groups.
 * @param {TagRelations} relations Relationships built from the caller's content snapshot.
 * @param {string} sourceLocale Language containing the source tag.
 * @param {string} tag Source tag text as written in frontmatter.
 * @param {string} targetLocale Requested language.
 * @returns {{status: "resolved", value: LocalizedTag} | {status: "ambiguous", candidates: LocalizedTag[]} | {status: "missing", reason: "unknown-source-tag" | "missing-translation"}} Lookup result for reuse or route fallback.
 */
export function resolveTagTranslation(
  relations,
  sourceLocale,
  tag,
  targetLocale
) {
  const group = relations.groups.get(JSON.stringify([sourceLocale, tag]));
  if (!group) return { status: "missing", reason: "unknown-source-tag" };
  if (group.ambiguous)
    return { status: "ambiguous", candidates: group.members };
  const value = group.members.find(member => member.locale === targetLocale);
  return value
    ? { status: "resolved", value }
    : { status: "missing", reason: "missing-translation" };
}
