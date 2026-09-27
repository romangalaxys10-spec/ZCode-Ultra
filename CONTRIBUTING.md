# Contributing to ZCode Ultra

Thanks for helping improve ZCode Ultra! This project values: small surface area, zero unnecessary dependencies, and safety-first defaults.

## Dev setup

```bash
git clone https://github.com/romangalaxys10-spec/ZCode-Ultra
cd ZCode-Ultra
npm install
npm run build          # tsc → dist/
npm test               # scripts/smoke.mjs (24 checks)
npm run e2e            # scripts/e2e-mock.mjs (mock-provider agent loop)
```

## Ground rules

1. **TypeScript strict** — `npm run typecheck` must pass; no `any` unless interfacing with untyped libs (baileys), and then isolate it.
2. **Dependency budget** — runtime deps require a strong justification. Prefer hand-rolling small utilities (see `src/util.ts`, `src/mcp/client.ts` for the house style).
3. **Safety is a feature** — any new tool must declare `readOnly` correctly, respect `checkApproval`, and pass through `scrubSecrets` for anything model-visible or bot-egress.
4. **Event-sourcing** — anything the model sees must flow through `Session.append` (the "model-visible means logged" invariant).
5. **Prompt changes** — update `src/core/context.ts` and run the e2e; keep the stable/volatile tier separation intact.
6. **Bots** — adapters stay thin: message transport + platform guards only. No business logic in `src/bots/*`.

## Testing without API keys

All core tests run against a scripted OpenAI-compatible mock (see `scripts/e2e-mock.mjs`). Add scenarios there for provider-layer changes.

## PR checklist

- [ ] `npm run typecheck && npm test && npm run e2e` green
- [ ] New tools: readOnly flag, approval path, docs entry in README table
- [ ] Config options: documented in docs/CONFIG.md
- [ ] No secrets in code, logs or fixtures (scrub patterns are the minimum bar)

## Release flow

1. Bump `package.json` version
2. Tag `vX.Y.Z` and push — the release workflow builds binaries (5 platforms), deb/rpm, npm publish (if `NPM_TOKEN` secret set), and attaches everything to the GitHub Release.
