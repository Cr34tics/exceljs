# Copilot Instructions

**The canonical agent-onboarding doc for this repo is [`CLAUDE.md`](../CLAUDE.md) at the repo
root — read it first.** The absolute minimum if you skip it:

- Setup: `corepack enable && yarn install` (Yarn 4). Fast test loop:
  `yarn test:unit && yarn test:integration` (no build required).
- In specs, load library code with the global `verquire('path/under/lib')` — never
  `require('../../lib/...')`.
- Formatting is Prettier-owned: **no semicolons**, single quotes, no max line length.
  `yarn lint` must pass with zero warnings.
- Never edit `dist/` (generated), never bump the `package.json` version in a PR, and update the
  hand-maintained `index.d.ts` for any public API change.

Architecture, xform patterns, test harness details, and release process: see `CLAUDE.md`.
