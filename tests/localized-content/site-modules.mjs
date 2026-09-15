import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export const siteRoot = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Load actual site utilities, page builders, and components without disk fixtures or content loading.
 * @param {object} registry Language registry used by this test module graph.
 * @param {Map<string, string>} sources In-memory replacements for content and layout boundaries.
 * @returns In-memory utility/component module URLs and the content collection setter.
 */
export async function createSiteModuleLoader(registry, sources = new Map()) {
  const modules = new Map();
  const collectionUrl = `data:text/javascript;base64,${Buffer.from(
    `let posts = [];
export function setPosts(value) { posts = value; }
export async function getCollection() { return posts; }`,
    "utf8"
  ).toString("base64")}`;
  const { setPosts } = await import(collectionUrl);

  function moduleUrl(file) {
    if (modules.has(file)) return modules.get(file);
    let source;
    if (sources.has(file)) source = sources.get(file);
    else if (file === path.join(siteRoot, "locales.config.mjs"))
      source = `export default ${JSON.stringify(registry)};`;
    else if (file === path.join(siteRoot, "src/content.config.ts")) {
      const schema = readFileSync(file, "utf8");
      source = [
        ...schema.matchAll(
          /^export const (?:BLOG_PATH|PAGES_PATH) = "[^"]+";/gm
        ),
      ]
        .map(match => match[0])
        .join("\n");
      assert.ok(source.includes("BLOG_PATH"));
    } else if (file.endsWith(".astro")) {
      const frontmatter = readFileSync(file, "utf8").match(
        /^---\r?\n([\s\S]*?)\r?\n---/
      )?.[1];
      assert.ok(frontmatter);
      const parsed = ts.createSourceFile(
        file,
        frontmatter,
        ts.ScriptTarget.ES2022,
        true,
        ts.ScriptKind.TS
      );
      source = parsed.statements
        .filter(
          statement =>
            ts.isImportDeclaration(statement) ||
            (ts.isFunctionDeclaration(statement) &&
              statement.name?.text === "getStaticPaths")
        )
        .map(statement => statement.getText(parsed))
        .join("\n");
    } else if (!file.endsWith(".ts")) return pathToFileURL(file).href;
    else source = readFileSync(file, "utf8");
    let code = ts
      .transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      })
      .outputText.replaceAll("import.meta.env.DEV", "false");
    const parsed = ts.createSourceFile(
      file,
      code,
      ts.ScriptTarget.ES2022,
      true
    );
    const replacements = [];
    for (const statement of parsed.statements) {
      if (
        (!ts.isImportDeclaration(statement) &&
          !ts.isExportDeclaration(statement)) ||
        !statement.moduleSpecifier ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      )
        continue;
      const specifier = statement.moduleSpecifier.text;
      if (specifier === "astro:content") {
        replacements.push({
          start: statement.moduleSpecifier.getStart(parsed),
          end: statement.moduleSpecifier.end,
          text: JSON.stringify(collectionUrl),
        });
        continue;
      }
      if (!specifier.startsWith("@/") && !specifier.startsWith(".")) continue;
      const resolved = specifier.startsWith("@/")
        ? path.join(siteRoot, "src", specifier.slice(2))
        : path.resolve(path.dirname(file), specifier);
      const target = [resolved, `${resolved}.ts`, `${resolved}.mjs`].find(
        candidate => existsSync(candidate)
      );
      assert.ok(target, `Cannot resolve ${specifier}`);
      replacements.push({
        start: statement.moduleSpecifier.getStart(parsed),
        end: statement.moduleSpecifier.end,
        text: JSON.stringify(moduleUrl(target)),
      });
    }
    for (const replacement of replacements.reverse())
      code =
        code.slice(0, replacement.start) +
        replacement.text +
        code.slice(replacement.end);
    const url = `data:text/javascript;base64,${Buffer.from(code, "utf8").toString("base64")}`;
    modules.set(file, url);
    return url;
  }

  async function componentUrl(file) {
    if (modules.has(file)) return modules.get(file);
    const astroRequire = createRequire(require.resolve("astro/package.json"));
    const { transform } = await import(
      pathToFileURL(astroRequire.resolve("@astrojs/compiler")).href
    );
    // Match Astro's runtime contract before resolving imports against the in-memory graph.
    const transformed = await transform(
      sources.get(file) ?? readFileSync(file, "utf8"),
      {
        filename: file.replaceAll("\\", "/"),
        internalURL: "astro/compiler-runtime",
        resultScopedSlot: true,
        renderScript: true,
        resolvePath: async specifier => specifier,
      }
    );
    let code = ts.transpileModule(transformed.code, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const parsed = ts.createSourceFile(
      file,
      code,
      ts.ScriptTarget.ES2022,
      true
    );
    const imports = [];
    function visit(node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier
      )
        imports.push(node.moduleSpecifier);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      )
        imports.push(node.arguments[0]);
      ts.forEachChild(node, visit);
    }
    visit(parsed);
    for (const specifier of imports.reverse()) {
      if (!ts.isStringLiteral(specifier)) continue;
      const name = specifier.text;
      let url;
      if (sources.has(name)) url = moduleUrl(name);
      else if (name.startsWith("@/") || name.startsWith(".")) {
        const resolved = name.startsWith("@/")
          ? path.join(siteRoot, "src", name.slice(2))
          : path.resolve(path.dirname(file), name);
        const target = [resolved, `${resolved}.ts`, `${resolved}.mjs`].find(
          candidate => sources.has(candidate) || existsSync(candidate)
        );
        assert.ok(target, `Cannot resolve ${name}`);
        url = target.endsWith(".astro")
          ? await componentUrl(target)
          : moduleUrl(target);
      } else if (name.startsWith("node:") || name.startsWith("data:"))
        url = name;
      else url = pathToFileURL(require.resolve(name)).href;
      code =
        code.slice(0, specifier.getStart(parsed)) +
        JSON.stringify(url) +
        code.slice(specifier.end);
    }
    const url = `data:text/javascript;base64,${Buffer.from(code, "utf8").toString("base64")}`;
    modules.set(file, url);
    return url;
  }
  return { moduleUrl, componentUrl, setPosts };
}
