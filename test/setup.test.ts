/** `/debate setup` wizard: fake pi UI, no models/tokens spent. */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, loadConfig, type DebateConfig } from "../config.ts";
import { runSetupWizard, tierPickerLabel, TIER_PICKER_COPY, type SetupContext } from "../setup.ts";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
function eq(name: string, got: unknown, want: unknown): void {
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

console.log("\n-- public tier picker copy --");
const ibmLabel = tierPickerLabel("ibm", (provider) => provider === "ibm-services-essentials");
eq("recommended profile is first-class public copy", ibmLabel,
  "IBM (recommended) · $0 · 3 distinct model perspectives · IBM ✓");
check("picker copy has no design-document leakage",
  !/§|WP|D8|quota|probe|cost\.total/i.test(Object.values(TIER_PICKER_COPY).map((c) => `${c.name} ${c.cost} ${c.summary}`).join(" ")));
const strongLabel = tierPickerLabel("strong", () => false);
check("missing credentials are readable", strongLabel.includes("OpenRouter · sign in") && strongLabel.includes("Codex · sign in"), strongLabel);
check("profile labels stay compact for an 80-column terminal", Math.max(ibmLabel.length, strongLabel.length) <= 80,
  `${ibmLabel.length}/${strongLabel.length}`);

console.log("\n-- setup wizard (§13.55) --");
// The full suite supplies an isolated PI_AGENT_DIR; retain direct `tsx test/setup.test.ts`
// usability as well, so this test never touches a developer's real trust store.
const createdAgentDir = process.env.PI_AGENT_DIR ? null : mkdtempSync(join(tmpdir(), "debate-setup-agent-"));
if (createdAgentDir) process.env.PI_AGENT_DIR = createdAgentDir;
const workspace = mkdtempSync(join(tmpdir(), "debate-setup-"));
const notices: string[] = [];
const selects: string[] = [];
const inputs = ["1.5h", "20m", "1234567"];
const confirms = [true, false, true]; // trust local, don't customise roles, final review
const ctx = {
  cwd: workspace,
  hasUI: true,
  scopedModels: [],
  isProjectTrusted: () => false,
  modelRegistry: {
    getProviderAuthStatus: (provider: string) => ({ configured: provider === "ibm-services-essentials" }),
    getAvailable: () => [],
  },
  ui: {
    select: async (title: string, options: string[]) => {
      selects.push(title);
      if (title.startsWith("Where")) return options.find((value) => value.startsWith("This project"));
      if (title.startsWith("Choose")) return options.find((value) => value.startsWith("IBM (recommended)"));
      throw new Error(`unexpected select: ${title}`);
    },
    confirm: async () => confirms.shift() ?? false,
    input: async () => inputs.shift(),
    editor: async () => "Review whether our migration plan has a safe rollback path.",
    notify: (message: string) => { notices.push(message); },
  },
} as unknown as SetupContext;

try {
  const result = await runSetupWizard(
    ctx,
    JSON.parse(JSON.stringify(DEFAULTS)) as DebateConfig,
    (trusted) => loadConfig(workspace, trusted).config,
  );
  check("wizard completed", result !== null);
  check("asked scope, tier, and topic", selects.length === 2, JSON.stringify(selects));
  eq("topic comes from editor", result?.seedText, "Review whether our migration plan has a safe rollback path.");
  eq("topic source identifies wizard", result?.seedSource, "setup editor");
  check("local config was saved", existsSync(join(workspace, ".pi", "debate.json")));
  const saved = JSON.parse(readFileSync(join(workspace, ".pi", "debate.json"), "utf8"));
  eq("minimal local config has selected tier", saved.tier, "ibm");
  eq("wizard writes canonical readable time keys", saved.timeouts, { total: "1.5h", turn: "20m" });
  eq("wizard writes free-tier token guardrail", saved.budget, { tokens: 1234567 });
  check("wizard writes no redundant role override", saved.roles === undefined);
  check("wizard persisted project trust", existsSync(join(process.env.PI_AGENT_DIR!, "trust.json")));
  const trust = JSON.parse(readFileSync(join(process.env.PI_AGENT_DIR!, "trust.json"), "utf8"));
  eq("only workspace gained trust", trust[workspace], true);
  eq("reloaded duration is milliseconds", result?.config.timeouts.totalMs, 5_400_000);
  eq("reloaded token cap is used", result?.config.budget.tokens, 1234567);
  check("UI says where it saved", notices.some((notice) => notice.includes("Saved")), notices.join("; "));
} finally {
  rmSync(workspace, { recursive: true, force: true });
  if (createdAgentDir) {
    rmSync(createdAgentDir, { recursive: true, force: true });
    delete process.env.PI_AGENT_DIR;
  }
}

if (fail) {
  console.error(`\nFAIL — ${pass} checks passed, ${fail} failed`);
  process.exit(1);
}
console.log(`\nPASS — ${pass} checks passed, 0 failed`);
