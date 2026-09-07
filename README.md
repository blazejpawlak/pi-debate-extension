# pi Debate Extension

A pi coding-agent extension that runs a structured multi-model debate: Ideator vs Skeptic with an independent Synthesizer verdict.

## Status

- WP0–WP5 complete.
- Offline fake-runner suite: 437 checks passing.
- Typecheck clean for pure extension logic.
- WP6 next: UI/session acceptance, especially immediate aborted-manifest persistence.

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
