// Intel gate. Fails if any shippable file leaks internal working material: planning-doc names,
// prior-project lineage, or how the code was produced. The repo goes public at submission, so this
// runs before any public flip (and in CI). Public artifacts that ship IN the repo are allowed to be
// named (README, SECURITY.md, LICENSE, FRICTION-LOG.md, docs/). The conformance table's own row ids
// (C-/T-/L-/R-n) and public MCP spec refs (SEP-nnnn) are allowed.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const SELF = "intel-gate.mjs";

// Each rule: a label and a regex. Keep these high-precision so a pass is meaningful.
const RULES = [
  [
    "private planning docs",
    /\b(00-PLAN|01-SPEC|02-ARCHITECTURE|03-BUILD|04-SPIKE|05-CONFORMANCE|06-THREAT-MODEL|07-OSS-LIBRARY|08-SUBMISSION)\b/,
  ],
  [
    "recon / internal docs",
    /\b(SDK-API\.md|SPEC-2025-11-25\.md|SERVER-DESIGN-DECISIONS|BUILD-CONVENTIONS)\b/,
  ],
  ["private dirs", /(^|[^A-Za-z0-9_])(plan\/recon|plan\/0[0-9]|\.hq)([^A-Za-z0-9_]|$)/],
  ["prior-project lineage", /\b(zkasuran\/overhear|MiniMax|overhear-eight|vercel\.app)\b/i],
  ["provenance phrasing", /\b(ported from|carried over from|derived from|adapted from)\b/i],
  ["build process", /\b(the brief|sub-?agent|fan[-\s]?out|agent swarm)\b/i],
  ["internal labels", /\b(WP-\d+|Q-\d+|D-\d+)\b/],
  ["spike / milestone", /\bat M[0-7]\b|\bmilestone M[0-7]\b|\b04-SPIKE\b|\bthe spike\b/i],
];

const EXTS = new Set([
  ".ts",
  ".mjs",
  ".js",
  ".md",
  ".json",
  ".svg",
  ".sh",
  ".html",
  ".css",
  ".yml",
  ".yaml",
]);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git" || name === "coverage")
      continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if ([...EXTS].some((e) => name.endsWith(e)) && basename(full) !== SELF) yield full;
  }
}

const hits = [];
for (const file of walk(".")) {
  if (file.includes("package-lock.json")) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const [label, re] of RULES) {
      const m = line.match(re);
      if (m) hits.push({ file, line: i + 1, label, text: line.trim().slice(0, 120) });
    }
  });
}

if (hits.length > 0) {
  console.error(`intel gate: ${hits.length} leak(s) of internal material in shippable files:`);
  for (const h of hits) console.error(`  ${h.file}:${h.line}  [${h.label}]  ${h.text}`);
  console.error(
    "Scrub these before the repo goes public. See the house rule on framing work as our own.",
  );
  process.exit(1);
}
console.log("intel gate: clean, no internal material found in shippable files.");
