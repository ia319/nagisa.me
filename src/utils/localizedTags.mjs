/** A tag ID or alias occupies one literal URL segment; never normalize it.
 * @param {unknown} value Untrusted ID or alias.
 */
export function isTagSegment(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !/[\s/\\?#%\u0000-\u001f\u007f]/u.test(value)
  );
}

/**
 * Diagnose missing definitions without preventing publication.
 * @param {readonly {path: string, tags: readonly string[]}[]} contents Article references.
 * @param {ReadonlySet<string>} knownIds Definitions in any language, including drafts.
 * @throws {Error} When an ID cannot be represented by the single-segment tag route.
 */
export function getTagReferenceDiagnostics(contents, knownIds) {
  const diagnostics = [];
  for (const content of contents) {
    for (const id of new Set(content.tags)) {
      if (!isTagSegment(id))
        throw new Error(
          `Invalid tag ID ${JSON.stringify(id)} in ${content.path}`
        );
      if (!knownIds.has(id))
        diagnostics.push({
          code: "missing-tag-definition",
          message: `Missing tag definition ${JSON.stringify(id)} in ${content.path}`,
        });
    }
  }
  return diagnostics;
}

/**
 * Resolve legacy segments only when a published canonical destination exists.
 * Reserve all defined and referenced IDs, including IDs without public routes.
 * Competing owners invalidate the alias for every owner, regardless of input order.
 * @param {readonly {id: string, locale: string, draft?: boolean, aliases?: readonly string[]}[]} definitions Localized metadata.
 * @param {readonly {tag: string, locale: string}[]} routes Public canonical routes.
 * @param {ReadonlySet<string>} reservedIds All canonical identities.
 */
export function getTagAliases(definitions, routes, reservedIds) {
  /** @type {Map<string, {locale: string, alias: string, ids: Set<string>}>} */
  const owners = new Map();
  const diagnostics = [];
  for (const definition of definitions) {
    if (definition.draft) continue;
    for (const alias of new Set(definition.aliases ?? [])) {
      if (alias === definition.id) continue;
      if (!isTagSegment(alias) || reservedIds.has(alias)) {
        diagnostics.push({
          code: "invalid-tag-alias",
          message: `Skip tag alias ${JSON.stringify(alias)} for ${definition.locale}/${definition.id}: invalid segment or reserved ID`,
        });
        continue;
      }
      const key = JSON.stringify([definition.locale, alias]);
      const owner = owners.get(key) ?? {
        locale: definition.locale,
        alias,
        ids: new Set(),
      };
      owner.ids.add(definition.id);
      owners.set(key, owner);
    }
  }
  const aliases = [];
  for (const [, { locale, alias, ids }] of [...owners].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )) {
    if (ids.size > 1) {
      diagnostics.push({
        code: "ambiguous-tag-alias",
        message: `Skip competing tag alias ${locale}/${alias}: ${[...ids].sort().join(", ")}`,
      });
      continue;
    }
    const [tag] = ids;
    if (routes.some(route => route.locale === locale && route.tag === tag))
      aliases.push({ locale, alias, tag });
  }
  return { aliases, diagnostics };
}
