import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import childProcess from "node:child_process";
import { readProjectFile } from "./snapshot.mjs";

async function inspectTarget(root, relativePath) {
  const base = path.resolve(root, "src/data/blog");
  const file = path.resolve(base, relativePath);
  const relative = path.relative(base, file);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative) ||
    !file.endsWith(".md")
  )
    throw new Error(`Invalid translation target: ${relativePath}`);
  const directory = path.dirname(file);
  if (
    (await fs.realpath(directory)) !== directory ||
    !(await fs.lstat(directory)).isDirectory()
  )
    throw new Error(
      `Target directory must not use symbolic links: ${relativePath}`
    );
  const names = await fs.readdir(directory);
  const filename = path.basename(file);
  if (
    names.some(
      name =>
        name !== filename &&
        name.normalize("NFC").toLowerCase() ===
          filename.normalize("NFC").toLowerCase()
    )
  )
    throw new Error(`Target path differs only by case: ${relativePath}`);
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (stat && !stat.isFile())
    throw new Error(`Target is not a regular file: ${relativePath}`);
  return {
    path: relativePath,
    file,
    mode: stat ? stat.mode & 0o777 : 0o666,
    before: stat
      ? await readProjectFile(root, path.relative(root, file))
      : undefined,
  };
}

async function verifyReplacementOwner(file, temporary, signal) {
  let sameOwner;
  if (process.platform === "win32") {
    // Node's Windows stats do not expose the owner SID; compare ACL owners without changing them.
    const script = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$originalOwner = [System.IO.File]::GetAccessControl($env:TRANSLATION_OWNER_TARGET, [System.Security.AccessControl.AccessControlSections]::Owner).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
$temporaryOwner = [System.IO.File]::GetAccessControl($env:TRANSLATION_OWNER_TEMP, [System.Security.AccessControl.AccessControlSections]::Owner).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if ($originalOwner -eq $temporaryOwner) { 'same' } else { 'different' }`;
    sameOwner = await new Promise((resolve, reject) => {
      childProcess.execFile(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          windowsHide: true,
          shell: false,
          timeout: 10000,
          signal,
          env: {
            ...process.env,
            TRANSLATION_OWNER_TARGET: file,
            TRANSLATION_OWNER_TEMP: temporary,
          },
        },
        (error, stdout) => {
          if (error)
            reject(
              new Error("Cannot verify Windows file ownership", {
                cause: error,
              })
            );
          else resolve(stdout.trim() === "same");
        }
      );
    });
  } else {
    const [original, replacement] = await Promise.all([
      fs.lstat(file),
      fs.lstat(temporary),
    ]);
    sameOwner =
      original.uid === replacement.uid && original.gid === replacement.gid;
  }
  if (!sameOwner)
    throw new Error(`Atomic replacement would change file ownership: ${file}`);
}

/**
 * Capture target contents and verify all directories before model execution.
 * @param {string} root Canonical project root.
 * @param {readonly {path: string, overwrite: boolean}[]} targets Kernel-validated targets.
 * @returns Prepared targets with original text for concurrent-edit checks.
 * @throws {Error} When targets are unsafe or existence differs from the kernel snapshot.
 */
export async function prepareWrites(root, targets) {
  const prepared = [];
  for (const target of targets) {
    const state = await inspectTarget(root, target.path);
    if ((state.before !== undefined) !== target.overwrite)
      throw new Error(
        `Target existence changed after planning: ${target.path}`
      );
    prepared.push(state);
  }
  return { root, targets: prepared };
}

/**
 * Publish validated articles atomically, retaining completed outputs on failure.
 * @param {Awaited<ReturnType<typeof prepareWrites>>} prepared Original target states.
 * @param {readonly {path: string, text: string}[]} outputs Complete kernel-validated output set.
 * @param {(message: string) => void} report Completion, failure, and retained temporary-file messages.
 * @param {AbortSignal} signal Command cancellation signal.
 * @returns {Promise<void>} Resolves after every target is published.
 * @throws {Error} When a target changes or any write fails; no batch rollback occurs.
 */
export async function writeTranslations(prepared, outputs, report, signal) {
  if (
    outputs.length !== prepared.targets.length ||
    outputs.some(
      (output, index) => output.path !== prepared.targets[index].path
    )
  )
    throw new Error("Output paths differ from the prepared write set");
  const completed = [];
  for (const [index, target] of prepared.targets.entries()) {
    let temporary;
    try {
      signal.throwIfAborted();
      if (
        (await inspectTarget(prepared.root, target.path)).before !==
        target.before
      )
        throw new Error(`Target changed during translation: ${target.path}`);
      const text = outputs[index].text;
      if (
        text.startsWith("\uFEFF") ||
        text.includes("\r") ||
        !text.endsWith("\n")
      )
        throw new Error(
          `Output must use UTF-8 without BOM, LF, and a final newline: ${target.path}`
        );
      const candidate = path.join(
        path.dirname(target.file),
        `.translation-${randomUUID()}.tmp`
      );
      const handle = await fs.open(candidate, "wx", target.mode);
      temporary = candidate;
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (target.before !== undefined)
        await verifyReplacementOwner(target.file, temporary, signal);
      signal.throwIfAborted();
      if (
        (await inspectTarget(prepared.root, target.path)).before !==
        target.before
      )
        throw new Error(`Target changed before publication: ${target.path}`);
      if (target.before === undefined) {
        // Linking publishes a complete new file and fails atomically if a target appeared.
        await fs.link(temporary, target.file);
        completed.push(target.path);
        try {
          await fs.unlink(temporary);
          temporary = undefined;
        } catch (error) {
          report(
            `Written target; temporary file retained: ${temporary}: ${error.message}`
          );
        }
      } else {
        await fs.rename(temporary, target.file);
        temporary = undefined;
        completed.push(target.path);
      }
      report(`Written: src/data/blog/${target.path}`);
    } catch (error) {
      report(`Completed: ${completed.join(", ") || "none"}`);
      report(`Failed: ${target.path}: ${error.message}`);
      report(
        `Pending: ${
          prepared.targets
            .slice(index + 1)
            .map(item => item.path)
            .join(", ") || "none"
        }`
      );
      if (temporary) report(`Temporary file retained for review: ${temporary}`);
      throw error;
    }
  }
}
