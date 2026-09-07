#!/usr/bin/env node

import { runTranslationCommand } from "./command.mjs";

const controller = new AbortController();
const cancel = () => controller.abort(new Error("Translation cancelled"));
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
  await runTranslationCommand(
    process.cwd(),
    process.argv.slice(2),
    message => process.stdout.write(`${message}\n`),
    controller.signal
  );
} catch (error) {
  process.stderr.write(`content:translate: ${error.message}\n`);
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
