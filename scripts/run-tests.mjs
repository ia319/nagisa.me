import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Node 20 needs explicit files; preserve the project-root working directory.
const directory = process.argv[2];
const files = readdirSync(directory, { encoding: "utf8", recursive: true })
  .filter(file => file.endsWith(".test.mjs"))
  .sort()
  .map(file => path.join(directory, file));
if (!files.length) throw new Error(`No test files found in ${directory}`);

const { error, status } = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
});
if (error) throw error;
process.exitCode = status ?? 1;
