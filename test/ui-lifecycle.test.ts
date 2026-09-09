/** UI lifecycle regression: debate chrome must exist only while a run is active. */

import { readFileSync } from "node:fs";
import { join } from "node:path";

let pass = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) pass++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const source = readFileSync(join(import.meta.dirname, "..", "index.ts"), "utf8");

check("no permanent verdict transcript renderer is registered",
  !source.includes('registerEntryRenderer("debate-verdict"'));
check("no permanent verdict transcript entry is appended",
  !source.includes('appendEntry("debate-verdict"'));
check("footer status uses documented clear API",
  source.includes('ctx.ui.setStatus("debate", undefined);'));
check("widget uses documented clear API",
  source.includes('ctx.ui.setWidget("debate", undefined);'));
check("unsafe undefined casts were removed",
  !source.includes("undefined as unknown as"));
check("cleanup detaches active run before clearing UI",
  source.indexOf("if (active === running) active = null;") <
    source.indexOf('ctx.ui.setStatus("debate", undefined);'));
check("normal run completion calls cleanup",
  /finally \{\s*await runner\.killAll\(\);\s*clearProgress\(ctx\);\s*\}/.test(source));
check("session shutdown always calls cleanup",
  /session_shutdown[\s\S]{0,500}clearProgress\(ctx, running\)/.test(source));
check("session startup removes stale UI from older versions",
  /session_start[\s\S]{0,200}clearProgress\(ctx, null\)/.test(source));
check("idle status query clears rather than pins UI",
  /case "status"[\s\S]{0,900}clearProgress\(ctx, null\)/.test(source) &&
    !source.includes('ctx.ui.setStatus("debate", `IDLE'));

console.log(`${failures.length === 0 ? "PASS" : "FAIL"} — ${pass} checks passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
