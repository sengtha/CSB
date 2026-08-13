#!/usr/bin/env node
"use strict";
/**
 * Find called-but-never-defined functions in the app's inline page scripts.
 *
 *   node scripts/check-page-js.js
 *
 * WHY THIS EXISTS. `node --check` parses; it does not resolve. A page that calls
 * a function nobody defined is syntactically perfect and fails the moment a
 * person clicks the thing. That shipped twice in one afternoon on oracle.html:
 * once as `renderUsd is not defined`, where an edit inserted the call but not
 * the function, and once as a call to `run()` copied from admin.html, where the
 * same job is done by a helper called `guard()`. Both passed every check the
 * repo had. Neither was visible without opening the page and clicking.
 *
 * The pages carry their logic inline rather than in modules, so there is no
 * bundler and no import graph to lean on. This walks the inline <script> blocks,
 * collects what each page declares plus what it inherits from common.js,
 * shell.js and connect.js, and reports every called name that is neither.
 *
 * IT IS A HEURISTIC AND WILL LIE OCCASIONALLY. Strings and comments are stripped
 * before matching, but a `"function transfer(address,uint256) returns (bool)"`
 * inside an awkwardly-quoted ABI array can still leave "returns (" behind, and
 * a browser global nobody thought to list reads as missing. So it reports rather
 * than fails: a clean run means nothing obvious is broken, and a flagged name
 * means go and look, not that the page is wrong. Exit code is 0 either way,
 * because a checker that blocks a commit on its own false positives gets
 * disabled within a week.
 */
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "app", "public");
const SHARED_FILES = ["common.js", "shell.js", "connect.js"];

// Language and browser names that are never declared by a page.
const GLOBALS = new Set((`
  Object Array String Number Boolean Math JSON Date RegExp Error TypeError Promise
  Map Set WeakMap WeakSet BigInt Symbol Proxy Reflect Intl
  parseInt parseFloat isNaN isFinite String Number
  encodeURIComponent decodeURIComponent encodeURI decodeURI
  setTimeout setInterval clearTimeout clearInterval queueMicrotask requestAnimationFrame
  fetch alert confirm prompt structuredClone
  console document window location navigator localStorage sessionStorage history
  URL URLSearchParams FormData Headers Request Response AbortController
  Option Image Audio Event CustomEvent Blob File FileReader
  TextEncoder TextDecoder Uint8Array ArrayBuffer DataView
  ethers
  if for while switch catch return typeof new delete void await async function
  class super this throw do else try finally instanceof in of let const var yield
`).trim().split(/\s+/));

/** Remove comments and string bodies so their contents cannot look like code. */
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

/** Names a chunk of source introduces into its own scope. */
function declared(src) {
  const d = new Set();
  const add = (n) => { if (/^[A-Za-z_$][\w$]*$/.test(n)) d.add(n); };
  for (const m of src.matchAll(/(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // Destructuring, arrow parameters and ordinary parameters all bind names that
  // are then called — `const { ethers } = ...`, `(fn) => fn()`.
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) add(part.split(":").pop().trim());
  }
  for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1]);
  for (const m of src.matchAll(/\(([^)]*)\)\s*=>/g)) {
    for (const part of m[1].split(",")) add(part.trim().split(/[\s=:]/)[0]);
  }
  for (const m of src.matchAll(/function[^(]*\(([^)]*)\)/g)) {
    for (const part of m[1].split(",")) add(part.trim().split(/[\s=:]/)[0]);
  }
  return d;
}

const inlineScripts = (file) =>
  [...fs.readFileSync(file, "utf8")
    .matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]).join("\n");

function main() {
  const shared = new Set();
  for (const f of SHARED_FILES) {
    const p = path.join(DIR, f);
    if (fs.existsSync(p)) declared(strip(fs.readFileSync(p, "utf8"))).forEach((n) => shared.add(n));
  }

  let flagged = 0, pages = 0;
  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith(".html")).sort()) {
    const raw = inlineScripts(path.join(DIR, file));
    if (!raw.trim()) continue;
    pages++;
    const src = strip(raw);
    const local = declared(src);
    const missing = new Set();
    for (const m of src.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[1];
      if (GLOBALS.has(name) || local.has(name) || shared.has(name)) continue;
      missing.add(name);
    }
    if (missing.size) {
      flagged++;
      console.log(`  ${file.padEnd(22)} ${[...missing].join(", ")}`);
    }
  }

  console.log("");
  console.log(flagged
    ? `${flagged} of ${pages} page(s) have names worth checking by hand (see the header — `
      + `ABI strings and unlisted browser globals both read as missing).`
    : `${pages} pages, nothing called that is not defined.`);
}

main();
