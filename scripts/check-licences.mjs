// Zero-dependency licence gate. Walks node_modules, reads each package's declared licence and fails on
// anything not on the allowlist (copyleft or unknown). SPDX OR-expressions pass if any term is allowed.
// Our own workspace packages are skipped. Run by verify.sh.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ALLOW = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "CC0-1.0",
  "CC-BY-4.0",
  "BlueOak-1.0.0",
  "Python-2.0",
  "Unlicense",
  "WTFPL",
]);

const OURS = /^@overhear\//;

function licenceOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license.type === "string") return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(" OR ");
  return "UNKNOWN";
}

// A licence string passes if any SPDX term in it (splitting on OR/AND and brackets) is allowed.
function passes(expr) {
  const terms = expr
    .replace(/[()]/g, " ")
    .split(/\s+(?:OR|AND)\s+/i)
    .map((t) => t.trim())
    .filter(Boolean);
  return terms.some((t) => ALLOW.has(t));
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === ".bin" || name === ".cache") continue;
    const full = join(dir, name);
    if (name.startsWith("@")) {
      yield* walk(full); // scope dir
      continue;
    }
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const pj = join(full, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(pj, "utf8"));
      if (pkg.name && !OURS.test(pkg.name)) {
        yield { name: pkg.name, version: pkg.version ?? "?", licence: licenceOf(pkg) };
      }
    } catch {
      // not a package dir
    }
    // nested node_modules
    yield* walk(join(full, "node_modules"));
  }
}

const offenders = [];
const seen = new Set();
for (const p of walk("node_modules")) {
  const key = `${p.name}@${p.version}`;
  if (seen.has(key)) continue;
  seen.add(key);
  if (!passes(p.licence)) offenders.push(p);
}

if (offenders.length > 0) {
  console.error(
    `licence gate: ${offenders.length} package(s) with a disallowed or unknown licence:`,
  );
  for (const o of offenders.sort((a, b) => a.name.localeCompare(b.name))) {
    console.error(`  ${o.name}@${o.version}  ${o.licence}`);
  }
  console.error(
    "Add the licence to the allowlist in scripts/check-licences.mjs only after reading it.",
  );
  process.exit(1);
}
console.log(`licence gate: ${seen.size} packages checked, all on the allowlist.`);
