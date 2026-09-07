import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

/** Build filesystem mocks only; these path labels never become disk fixtures. */
export function memoryFiles(t, contents) {
  const root = path.resolve("virtual-translation-project");
  const entries = new Map([[root, { kind: "directory" }]]);
  const reads = [];
  for (const [relative, value] of Object.entries(contents)) {
    const file = path.join(root, relative);
    entries.set(
      file,
      typeof value === "string" ? { kind: "file", text: value } : value
    );
    for (
      let directory = path.dirname(file);
      directory !== root;
      directory = path.dirname(directory)
    )
      entries.set(directory, { kind: "directory" });
  }
  function get(file) {
    const entry = entries.get(file);
    if (!entry)
      throw Object.assign(new Error(`Missing memory entry: ${file}`), {
        code: "ENOENT",
      });
    return entry;
  }
  function stat(file) {
    const entry = get(file);
    return {
      name: path.basename(file),
      isFile: () => entry.kind === "file",
      isDirectory: () => entry.kind === "directory",
      isSymbolicLink: () => entry.kind === "symlink",
    };
  }
  t.mock.method(fs, "lstat", async file => stat(file));
  t.mock.method(fs, "realpath", async file => get(file).target ?? file);
  t.mock.method(fs, "readdir", async (directory, options) => {
    assert.equal(get(directory).kind, "directory");
    return [...entries.keys()]
      .filter(file => file !== root && path.dirname(file) === directory)
      .map(file => (options?.withFileTypes ? stat(file) : path.basename(file)));
  });
  t.mock.method(fs, "readFile", async (file, encoding) => {
    assert.equal(encoding, "utf8");
    assert.equal(get(file).kind, "file");
    reads.push(file);
    return get(file).text;
  });
  return { root, entries, reads };
}
