/* ═══════════════════════════════════════════════════════════════════
   tests/run.js — Node runner for the shared suite.

     node tests/run.js

   Loads the browser-style modules (plain IIFEs attaching to globalThis)
   into this context, then executes tests/suite.js.
   ═══════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const MODULES = ["js/config.js", "js/notes.js", "js/sargam.js", "js/pitch.js",
  "js/sa.js", "js/tracker.js", "js/stats.js", "js/simulation.js", "js/history.js",
  "tests/suite.js"];

MODULES.forEach((f) => {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), "utf8"), { filename: f });
});

const result = globalThis.FPA_TEST_SUITE.run(globalThis.FPA);
console.log(result.lines.join("\n"));
console.log("\n" + "\u2500".repeat(58));
console.log("  " + result.passed + " passed, " + result.failed + " failed");
if (result.failed) {
  console.log("\nFailures:");
  result.failures.forEach((f) => console.log("  \u2022 " + f.name + "\n    " + f.message));
  process.exit(1);
}
console.log("  All good.");
