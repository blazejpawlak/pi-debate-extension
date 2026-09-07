# pi Debate Extension

A pi coding-agent extension that runs a structured multi-model debate: Ideator vs Skeptic with an independent Synthesizer verdict.

## Status

- WP0–WP6 complete.
- Offline fake-runner suite: 465 checks passing.
- Typecheck clean for pure extension logic.
- WP6 complete: abort persistence, verdict entry renderer, full-verdict injection, testable stale-run sweep.
- WP7 optional (harness adapter + publisher, not started). WP8 pending: the full 51.8KB evaluation.

See `docs/handoff-wp6.md` for the latest handoff and `docs/design/debate-swarm-design.md` for the work order.

## Local development

```bash
npm install
npm test
```

Real-token tests are intentionally excluded from `npm test`; run `npx tsx test/runner-direct.test.ts` explicitly when needed.

## Linking into pi

The recommended local setup is a symlink from pi's global extension discovery directory:

```bash
ln -s ~/Projects/pi-debate-extension ~/.pi/agent/extensions/debate
```

This keeps the GitHub repository as the editable source while pi continues to auto-discover the `debate` extension.

## Repository layout

| Path | Contents |
| --- | --- |
| `index.ts` | Extension registration and glue (not unit-testable; needs pi's loader) |
| `command.ts` | Pure argument/mode parsing |
| `config.ts` | Layered config, tiers, per-role resolution |
| `orchestrator.ts` | State machine, budgets, repair, resume |
| `ledger.ts` | Claim ledger contract and write-permission enforcement |
| `excerpts.ts` | `sourceRef` → seed span resolution |
| `prompts.ts` | Mission assembly |
| `verdict.ts` | Verdict rendering |
| `manifest.ts` | Run manifest and `events.jsonl` |
| `runner/` | `direct.ts` (real models), `fake.ts` (offline), shared types |
| `personas/` | Ideator, Skeptic, Synthesizer persona bodies |
| `test/` | Offline suite plus one explicit real-token test |
| `docs/design/` | Work order and the external design review |
| `docs/eval/` | Probe, re-probe, and WP4 evaluation artifacts |
| `docs/handoff-wp6.md` | Current handoff |
