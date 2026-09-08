import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export const siteRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Load actual site utilities and page builders without disk fixtures or Astro content loading.
 * @param {object} registry Language registry used by this test module graph.
 * @returns In-memory module URLs and the content collection setter.
 */
export async function createSiteModuleLoader(registry) {
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
    if (file === path.join(siteRoot, "locales.config.mjs"))
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
  return { moduleUrl, setPosts };
}
