/**
 * paths.ts — run directory layout (§3) and run-id generation.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";

/** `run-id` = YYYYMMDD-HHMMSS-<4 hex> (§3). */
export function newRunId(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

export interface RunPaths {
  root: string;
  debateDir: string;
  runsDir: string;
  runDir: string;
  manifest: string;
  seed: string;
  ledger: string;
  judgeDir: string;
  judgeExcerpts: string;
  judgeLedger: string;
  turnsDir: string;
  events: string;
  transcript: string;
  lessons: string;
  rootVerdict: string;
}

export function runPaths(workspace: string, runId: string): RunPaths {
  const debateDir = join(workspace, ".debate");
  const runsDir = join(debateDir, "runs");
  const runDir = join(runsDir, runId);
  const judgeDir = join(runDir, "judge");
  const turnsDir = join(runDir, "turns");
  return {
    root: workspace,
    debateDir,
    runsDir,
    runDir,
    manifest: join(runDir, "manifest.json"),
    seed: join(runDir, "seed.md"),
    ledger: join(runDir, "ledger.json"),
    judgeDir,
    judgeExcerpts: join(judgeDir, "excerpts.md"),
    judgeLedger: join(judgeDir, "ledger.json"),
    turnsDir,
    events: join(runDir, "events.jsonl"),
    transcript: join(runDir, "transcript.jsonl"),
    lessons: join(debateDir, "lessons.md"),
    rootVerdict: join(workspace, "debate_verdict.md"),
  };
}

export function ensureRunDirs(p: RunPaths): void {
  for (const d of [p.debateDir, p.runsDir, p.runDir, p.judgeDir, p.turnsDir]) {
    mkdirSync(d, { recursive: true });
  }
}

/** Turn artifact name, e.g. `r1-ideator.md` / `verdict.md` (§3). */
export function turnFileName(round: 1 | 2 | 3 | "verdict", role: string): string {
  return round === "verdict" ? "verdict.md" : `r${round}-${role}.md`;
}

export interface RunSummary {
  runId: string;
  status: string;
  mode?: string;
  costUsd?: number;
  startedAt?: string;
  endedAt?: string;
  manifestPath: string;
}

/** List runs newest-first by directory name (run-ids sort chronologically). */
export function listRuns(workspace: string): RunSummary[] {
  const runsDir = join(workspace, ".debate", "runs");
  if (!existsSync(runsDir)) return [];
  const out: RunSummary[] = [];
  for (const name of readdirSync(runsDir)) {
    const manifestPath = join(runsDir, name, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const m = JSON.parse(readFileSync(manifestPath, "utf8"));
      out.push({
        runId: m.runId ?? name,
        status: m.status ?? "unknown",
        mode: m.mode,
        costUsd: m.totals?.costUsd,
        startedAt: m.startedAt,
        endedAt: m.endedAt,
        manifestPath,
      });
    } catch {
      out.push({ runId: name, status: "unreadable", manifestPath });
    }
  }
  return out.sort((a, b) => (a.runId < b.runId ? 1 : -1));
}
