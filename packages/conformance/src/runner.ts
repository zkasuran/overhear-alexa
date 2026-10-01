// Runs the conformance checks against a url+token and formats the result table (see README.md).
// No console here: the CLI prints and writes files.
// This module measures each check's wall-clock time and decides the overall verdict.

import type { Check, CheckContext, Outcome, Result } from "./checks.js";
import { CHECKS } from "./checks.js";

export const TOOL_NAME = "overhear-conformance";
export const TOOL_VERSION = "1.0.0";

export type RunResultRow = {
  id: string;
  title: string;
  specBasis: string;
  advisory: boolean;
  outcome: Outcome;
  detail: string;
  ms: number;
  observed?: unknown;
};

export type RunReport = {
  tool: string;
  version: string;
  target: string;
  protocolVersion: string;
  startedAt: string;
  rows: RunResultRow[];
  passed: number;
  total: number;
  requiredNotPassed: number;
  ok: boolean;
};

/** Run every check in order against ctx. Checks that throw are recorded as outcome "error". */
export async function runConformance(
  ctx: CheckContext,
  checks: readonly Check[] = CHECKS,
): Promise<RunReport> {
  const rows: RunResultRow[] = [];
  for (const check of checks) {
    const start = performance.now();
    let outcome: Result;
    try {
      outcome = await check.run(ctx);
    } catch (e) {
      outcome = { outcome: "error", detail: e instanceof Error ? e.message : String(e) };
    }
    const ms = Math.round(performance.now() - start);
    const row: RunResultRow = {
      id: check.id,
      title: check.title,
      specBasis: check.specBasis,
      advisory: check.advisory === true,
      outcome: outcome.outcome,
      detail: outcome.detail,
      ms,
    };
    if (outcome.observed !== undefined) row.observed = outcome.observed;
    rows.push(row);
  }
  const passed = rows.filter((r) => r.outcome === "pass").length;
  // Exit code rests on this: every non-advisory row must pass (skip and error do not count).
  const requiredNotPassed = rows.filter((r) => !r.advisory && r.outcome !== "pass").length;
  return {
    tool: TOOL_NAME,
    version: TOOL_VERSION,
    target: ctx.url,
    protocolVersion: ctx.protocolVersion,
    startedAt: new Date().toISOString(),
    rows,
    passed,
    total: rows.length,
    requiredNotPassed,
    ok: requiredNotPassed === 0,
  };
}

const LEADER_WIDTH = 66;

/** Format a report as the conformance "Output format" table: a header, one row each, a tally. */
export function formatReport(report: RunReport): string {
  const lines: string[] = [];
  lines.push(
    `${report.tool} ${report.version}  target=${report.target}  protocol=${report.protocolVersion}  ${report.startedAt}`,
  );
  for (const r of report.rows) {
    const label = r.outcome.toUpperCase();
    const left = `${r.id.padEnd(4)} ${r.title} `;
    const dots = left.length >= LEADER_WIDTH ? "" : ".".repeat(LEADER_WIDTH - left.length);
    let line = `${left}${dots} ${label}  ${r.ms}ms`;
    if (r.advisory) line += "  (advisory)";
    if (r.outcome !== "pass") line += `  ${r.detail}`;
    lines.push(line);
  }
  lines.push(`${report.passed}/${report.total} PASS`);
  return lines.join("\n");
}
