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
 * Case-insensitive conflicts invalidate every competing alias, regardless of input order.
 * @param {readonly {id: string, locale: string, draft?: boolean, aliases?: readonly string[]}[]} definitions Localized metadata.
 * @param {readonly {tag: string, locale: string}[]} routes Public canonical routes.
 * @param {ReadonlySet<string>} reservedIds All canonical identities.
 */
export function getTagAliases(definitions, routes, reservedIds) {
  const reservedKeys = new Set(
    [...reservedIds].map(id => id.normalize("NFC").toLowerCase())
  );
  /** @type {Map<string, {locale: string, aliases: Set<string>, ids: Set<string>}>} */
  const owners = new Map();
  const diagnostics = [];
  for (const definition of definitions) {
    if (definition.draft) continue;
    for (const alias of new Set(definition.aliases ?? [])) {
      if (alias === definition.id) continue;
      if (
        !isTagSegment(alias) ||
        reservedKeys.has(alias.normalize("NFC").toLowerCase())
      ) {
        diagnostics.push({
          code: "invalid-tag-alias",
          message: `Skip tag alias ${JSON.stringify(alias)} for ${definition.locale}/${definition.id}: invalid segment or reserved ID`,
        });
        continue;
      }
      const key = JSON.stringify([
        definition.locale,
        alias.normalize("NFC").toLowerCase(),
      ]);
      const owner = owners.get(key) ?? {
        locale: definition.locale,
        aliases: new Set(),
        ids: new Set(),
      };
      owner.aliases.add(alias);
      owner.ids.add(definition.id);
      owners.set(key, owner);
    }
  }
  const aliases = [];
  for (const [, { locale, aliases: spellings, ids }] of [...owners].sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)
  )) {
    if (ids.size > 1 || spellings.size > 1) {
      diagnostics.push({
        code: "ambiguous-tag-alias",
        message: `Skip competing tag aliases ${JSON.stringify([...spellings].sort())} in ${locale}: ${[...ids].sort().join(", ")}`,
      });
      continue;
    }
    const [tag] = ids;
    const [alias] = spellings;
    if (routes.some(route => route.locale === locale && route.tag === tag))
      aliases.push({ locale, alias, tag });
  }
  return { aliases, diagnostics };
}
