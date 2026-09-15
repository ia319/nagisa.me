import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setDefaultLocale } from "../../scripts/locale-config/default-locale.mjs";
import {
  createVercelConfig,
  serializeVercelConfig,
} from "../../scripts/locale-config/vercel.mjs";

const locales = {
  fr: { label: "Français", dir: "ltr" },
  en: { label: "English", dir: "ltr" },
  "zh-Hant": { label: "繁體中文", dir: "ltr" },
  ar: { label: "العربية", dir: "rtl" },
};
const markdown = "---\ntitle: Exemple\ntags: [Astro]\n---\n\nTexte 中文.\n";

function fixture(t, files, defaultLocale = "fr") {
  // These paths label in-memory entries only; no fixture reaches the disk.
  const root = path.resolve("virtual-locale-project");
  const registry = { defaultLocale, locales };
  const registryText = `// Preserve this comment and the locale definitions.\nconst localeRegistry = /** @type {const} */ ({\n  defaultLocale: "${defaultLocale}",\n  locales: ${JSON.stringify(locales, null, 2)},\n});\nexport default localeRegistry;\n`;
  const dictionaries = Object.fromEntries(
    Object.keys(locales).map(locale => [
      locale,
      { greeting: "Hello", farewell: "Goodbye" },
    ])
  );
  const vercelText = serializeVercelConfig(
    createVercelConfig(
      {
        regions: ["sin1"],
        routes: [{ src: "^/api/(.*)$", dest: "/api/$1" }],
      },
      registry
    )
  );
  const contents = {
    "locales.config.mjs": registryText,
    "src/i18n/ui-dictionaries.mjs": `export const UI_DICTIONARIES = ${JSON.stringify(dictionaries)};\n`,
    "vercel.json": vercelText,
    ...files,
  };
  const entries = new Map([[root, { directory: true }]]);
  for (const [relativePath, text] of Object.entries(contents)) {
    const file = path.join(root, relativePath);
    entries.set(file, { text });
    for (let dir = path.dirname(file); dir !== root; dir = path.dirname(dir)) {
      entries.set(dir, { directory: true });
    }
  }

  function getEntry(file) {
    const entry = entries.get(file);
    if (!entry) {
      throw Object.assign(new Error(`Missing in-memory entry: ${file}`), {
        code: "ENOENT",
      });
    }
    return {
      name: path.basename(file),
      isDirectory: () => entry.directory === true,
      isFile: () => !entry.directory,
      isSymbolicLink: () => false,
    };
  }

  t.mock.method(fs, "realpath", async file => {
    getEntry(file);
    return file;
  });
  t.mock.method(fs, "lstat", async file => getEntry(file));
  t.mock.method(fs, "stat", async file => getEntry(file));
  t.mock.method(fs, "readdir", async (dir, options) => {
    assert.ok(getEntry(dir).isDirectory());
    return [...entries.keys()]
      .filter(file => file !== root && path.dirname(file) === dir)
      .map(file =>
        options?.withFileTypes ? getEntry(file) : path.basename(file)
      );
  });
  t.mock.method(fs, "readFile", async (file, encoding) => {
    assert.equal(encoding, "utf8");
    assert.ok(getEntry(file).isFile());
    return entries.get(file).text;
  });
  t.mock.method(fs, "writeFile", async (file, text, encoding) => {
    assert.equal(encoding, "utf8");
    assert.ok(getEntry(path.dirname(file)).isDirectory());
    entries.set(file, { text });
  });
  t.mock.method(fs, "rename", async (source, target) => {
    assert.ok(getEntry(source).isFile());
    assert.ok(getEntry(path.dirname(target)).isDirectory());
    assert.ok(!entries.has(target));
    entries.set(target, entries.get(source));
    entries.delete(source);
  });
  return { root, registryText, vercelText, dictionaries, entries };
}

test("switches configuration, content filenames, and deployment in order", async t => {
  const { root, registryText } = fixture(t, {
    "src/data/blog/guides/guide.md": markdown,
    "src/data/blog/guides/guide.en.md": "English\n",
    "src/data/blog/guides/guide.zh-Hant.md": "中文\n",
    "src/data/blog/releases/version.2.md": markdown,
    "src/data/blog/_notes.md": "ignored\n",
    "src/data/blog/.hidden.md": "ignored\n",
    "src/data/blog/.hidden/guide.md": "ignored\n",
    "src/data/blog/_guides/指南.md": markdown,
    "src/data/pages/about.md": markdown,
    "src/data/pages/about.en.md": "English page\n",
  });
  const messages = [];
  await setDefaultLocale(root, "en", undefined, message =>
    messages.push(message)
  );

  assert.equal(
    await fs.readFile(path.join(root, "locales.config.mjs"), "utf8"),
    registryText.replace('defaultLocale: "fr"', 'defaultLocale: "en"')
  );
  for (const name of [
    "blog/guides/guide",
    "blog/releases/version.2",
    "blog/_guides/指南",
    "pages/about",
  ]) {
    assert.equal(
      await fs.readFile(path.join(root, `src/data/${name}.fr.md`), "utf8"),
      markdown
    );
    await assert.rejects(fs.stat(path.join(root, `src/data/${name}.md`)), {
      code: "ENOENT",
    });
  }
  for (const file of ["_notes.md", ".hidden.md", ".hidden/guide.md"]) {
    assert.equal(
      await fs.readFile(path.join(root, "src/data/blog", file), "utf8"),
      "ignored\n"
    );
  }
  assert.equal(
    await fs.readFile(
      path.join(root, "src/data/blog/guides/guide.en.md"),
      "utf8"
    ),
    "English\n"
  );
  assert.equal(
    await fs.readFile(
      path.join(root, "src/data/blog/guides/guide.zh-Hant.md"),
      "utf8"
    ),
    "中文\n"
  );
  const vercel = JSON.parse(
    await fs.readFile(path.join(root, "vercel.json"), "utf8")
  );
  assert.equal(
    vercel.routes.filter(route => route.src === "^/$").at(-1).dest,
    "/en/"
  );
  assert.deepEqual(vercel.regions, ["sin1"]);
  assert.deepEqual(vercel.routes.at(-1), {
    src: "^/api/(.*)$",
    dest: "/api/$1",
  });
  assert.equal(messages[0], "Updated: locales.config.mjs");
  assert.ok(messages.findIndex(message => message.startsWith("Renamed:")) > 0);
  assert.equal(messages.at(-2), "Updated: vercel.json");
});

test("skips all writes on a completed rerun", async t => {
  const { root } = fixture(t, { "src/data/pages/about.md": markdown });
  await setDefaultLocale(root, "en", undefined, () => {});
  const write = t.mock.method(fs, "writeFile");
  const rename = t.mock.method(fs, "rename");
  const messages = [];
  await setDefaultLocale(root, "en", undefined, message =>
    messages.push(message)
  );
  assert.equal(write.mock.callCount(), 0);
  assert.equal(rename.mock.callCount(), 0);
  assert.ok(
    messages.includes("Skip unchanged configuration: locales.config.mjs")
  );
  assert.ok(messages.includes("Skip unchanged configuration: vercel.json"));
  assert.ok(
    messages.includes("Skip unchanged filename: src/data/pages/about.fr.md")
  );
});

test("uses an explicit source after a manual default change without guessing it", async t => {
  const { root } = fixture(t, { "src/data/pages/about.md": markdown }, "en");
  const messages = [];
  await setDefaultLocale(root, "en", undefined, message =>
    messages.push(message)
  );
  assert.equal(
    await fs.readFile(path.join(root, "src/data/pages/about.md"), "utf8"),
    markdown
  );
  assert.match(messages.join("\n"), /no historical source locale was supplied/);
  await setDefaultLocale(root, "en", "fr", () => {});
  assert.equal(
    await fs.readFile(path.join(root, "src/data/pages/about.fr.md"), "utf8"),
    markdown
  );
});

test("preserves completed renames and reports a retry after a partial failure", async t => {
  const { root, vercelText } = fixture(t, {
    "src/data/blog/a.md": markdown,
    "src/data/blog/b.md": markdown,
    "src/data/pages/about.md": markdown,
  });
  const originalRename = fs.rename;
  const rename = t.mock.method(fs, "rename", async (source, target) => {
    if (source.endsWith(`${path.sep}b.md`))
      throw new Error("Simulated rename failure");
    return originalRename(source, target);
  });
  const messages = [];
  await assert.rejects(
    setDefaultLocale(root, "en", undefined, message => messages.push(message)),
    /Simulated rename failure/
  );
  assert.match(
    await fs.readFile(path.join(root, "locales.config.mjs"), "utf8"),
    /defaultLocale: "en"/
  );
  assert.equal(
    await fs.readFile(path.join(root, "src/data/blog/a.fr.md"), "utf8"),
    markdown
  );
  assert.equal(
    await fs.readFile(path.join(root, "src/data/blog/b.md"), "utf8"),
    markdown
  );
  assert.equal(
    await fs.readFile(path.join(root, "vercel.json"), "utf8"),
    vercelText
  );
  assert.match(
    messages.join("\n"),
    /Completed: locales.config.mjs; src\/data\/blog\/a.md -> src\/data\/blog\/a.fr.md/
  );
  assert.match(messages.join("\n"), /Failed: src\/data\/blog\/b.md/);
  assert.match(
    messages.join("\n"),
    /Pending: src\/data\/pages\/about.md; vercel.json/
  );
  assert.match(messages.join("\n"), /pnpm locales:set-default en --from fr/);
  rename.mock.restore();
  await setDefaultLocale(root, "en", "fr", () => {});
  assert.equal(
    await fs.readFile(path.join(root, "src/data/blog/b.fr.md"), "utf8"),
    markdown
  );
  assert.equal(
    await fs.readFile(path.join(root, "src/data/pages/about.fr.md"), "utf8"),
    markdown
  );
});

test("retains renamed files when deployment writing fails and can retry", async t => {
  const { root, vercelText } = fixture(t, {
    "src/data/pages/about.md": markdown,
  });
  const originalWrite = fs.writeFile;
  const write = t.mock.method(fs, "writeFile", async (file, ...args) => {
    if (file === path.join(root, "vercel.json"))
      throw new Error("Simulated deployment failure");
    return originalWrite(file, ...args);
  });
  await assert.rejects(
    setDefaultLocale(root, "en", undefined, () => {}),
    /Simulated deployment failure/
  );
  assert.equal(
    await fs.readFile(path.join(root, "src/data/pages/about.fr.md"), "utf8"),
    markdown
  );
  assert.equal(
    await fs.readFile(path.join(root, "vercel.json"), "utf8"),
    vercelText
  );
  write.mock.restore();
  await setDefaultLocale(root, "en", undefined, () => {});
  assert.notEqual(
    await fs.readFile(path.join(root, "vercel.json"), "utf8"),
    vercelText
  );
});

test("does not rename content when the first configuration write fails", async t => {
  const { root, registryText, vercelText } = fixture(t, {
    "src/data/pages/about.md": markdown,
  });
  t.mock.method(fs, "writeFile", async () => {
    throw new Error("Simulated configuration failure");
  });
  await assert.rejects(
    setDefaultLocale(root, "en", undefined, () => {}),
    /Simulated configuration failure/
  );
  assert.equal(
    await fs.readFile(path.join(root, "locales.config.mjs"), "utf8"),
    registryText
  );
  assert.equal(
    await fs.readFile(path.join(root, "vercel.json"), "utf8"),
    vercelText
  );
  assert.equal(
    await fs.readFile(path.join(root, "src/data/pages/about.md"), "utf8"),
    markdown
  );
});

test("rejects duplicate identities before any write", async t => {
  const { root, registryText } = fixture(t, {
    "src/data/blog/guide.md": markdown,
    "src/data/pages/about.md": markdown,
    "src/data/pages/about.fr.md": markdown,
  });
  await assert.rejects(
    setDefaultLocale(root, "en", undefined, () => {}),
    /define the same base path and locale/
  );
  assert.equal(
    await fs.readFile(path.join(root, "locales.config.mjs"), "utf8"),
    registryText
  );
  assert.equal(
    await fs.readFile(path.join(root, "src/data/blog/guide.md"), "utf8"),
    markdown
  );
});

test("preflights directory targets and case-insensitive collisions", async t => {
  for (const filename of ["guide.fr.md", "guide.FR.md"]) {
    await t.test(filename, async t => {
      const { root, registryText, entries } = fixture(t, {
        "src/data/blog/guide.md": markdown,
      });
      entries.set(path.join(root, "src/data/blog", filename), {
        directory: true,
      });
      await assert.rejects(
        setDefaultLocale(root, "en", undefined, () => {}),
        /Rename target already exists/
      );
      assert.equal(
        await fs.readFile(path.join(root, "locales.config.mjs"), "utf8"),
        registryText
      );
    });
  }
});

test("rejects unknown languages and incomplete UI before writing", async t => {
  const { root, registryText, dictionaries } = fixture(t, {});
  await assert.rejects(
    setDefaultLocale(root, "de", undefined, () => {}),
    /Locale "de" is not configured/
  );
  await assert.rejects(
    setDefaultLocale(root, "en", "de", () => {}),
    /Locale "de" is not configured/
  );
  delete dictionaries.en.farewell;
  await fs.writeFile(
    path.join(root, "src/i18n/ui-dictionaries.mjs"),
    `export const UI_DICTIONARIES = ${JSON.stringify(dictionaries)};\n`,
    "utf8"
  );
  await assert.rejects(
    setDefaultLocale(root, "en", undefined, () => {}),
    /Locale "en" is missing UI keys: farewell/
  );
  assert.equal(
    await fs.readFile(path.join(root, "locales.config.mjs"), "utf8"),
    registryText
  );
});

test("rejects computed defaults instead of rewriting arbitrary JavaScript", async t => {
  const { root, registryText } = fixture(t, {});
  const computed = registryText.replace(
    'defaultLocale: "fr"',
    'defaultLocale: ["fr"][0]'
  );
  await fs.writeFile(path.join(root, "locales.config.mjs"), computed, "utf8");
  await assert.rejects(
    setDefaultLocale(root, "en", undefined, () => {}),
    /string literal on its own line/
  );
  assert.equal(
    await fs.readFile(path.join(root, "locales.config.mjs"), "utf8"),
    computed
  );
});

test("writes changed registry text as UTF-8 without BOM and LF", async t => {
  const { root, registryText } = fixture(t, {});
  await fs.writeFile(
    path.join(root, "locales.config.mjs"),
    `\uFEFF${registryText.replaceAll("\n", "\r\n")}`,
    "utf8"
  );
  await setDefaultLocale(root, "en", undefined, () => {});
  assert.equal(
    await fs.readFile(path.join(root, "locales.config.mjs"), "utf8"),
    registryText.replace('defaultLocale: "fr"', 'defaultLocale: "en"')
  );
});

test("accepts absent content directories and regional default locales", async t => {
  const { root } = fixture(t, {});
  await setDefaultLocale(root, "zh-Hant", undefined, () => {});
  assert.match(
    await fs.readFile(path.join(root, "locales.config.mjs"), "utf8"),
    /defaultLocale: "zh-Hant"/
  );
  const vercel = JSON.parse(
    await fs.readFile(path.join(root, "vercel.json"), "utf8")
  );
  assert.equal(
    vercel.routes.filter(route => route.src === "^/$").at(-1).dest,
    "/zh-Hant/"
  );
});

test("rejects a redirected content directory before writing", async t => {
  const { root, registryText } = fixture(t, {
    "src/data/blog/guide.md": markdown,
  });
  const originalRealpath = fs.realpath;
  t.mock.method(fs, "realpath", async file =>
    file === path.join(root, "src/data/blog")
      ? path.join(root, "outside")
      : originalRealpath(file)
  );
  await assert.rejects(
    setDefaultLocale(root, "en", undefined, () => {}),
    /Content directory must not use symbolic links/
  );
  assert.equal(
    await fs.readFile(path.join(root, "locales.config.mjs"), "utf8"),
    registryText
  );
});

test("exposes CLI help and rejects malformed arguments without file writes", async () => {
  const run = promisify(execFile);
  const cli = fileURLToPath(
    new URL("../../scripts/locale-config/set-default.mjs", import.meta.url)
  );
  const options = {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    encoding: "utf8",
    windowsHide: true,
  };
  for (const args of [[], ["--help"], ["-h"]]) {
    const { stdout, stderr } = await run(
      process.execPath,
      [cli, ...args],
      options
    );
    assert.match(stdout, /Usage: pnpm locales:set-default <locale>/);
    assert.equal(stderr, "");
  }
  for (const args of [
    ["en", "fr"],
    ["--from", "fr"],
    ["--unknown"],
    ["--from"],
  ]) {
    await assert.rejects(
      run(process.execPath, [cli, ...args], options),
      error => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /locales:set-default:/);
        assert.equal(error.stdout, "");
        return true;
      }
    );
  }
});
