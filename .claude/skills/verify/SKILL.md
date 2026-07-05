---
name: verify
description: Verify a change in this repo end-to-end — pick the test tier for the change type (xform, doc model, public API, build/browser, streaming), know when a build is required, run the EXCEL_BUILD=cjs matrix, pass lint and format gates, and prove behavior with a write-then-read xlsx smoke test. Use before committing or claiming a change works.
---

# Verifying a change

Ignore README.md for tooling — it is upstream exceljs's. This fork: Yarn 4 via Corepack
(`corepack enable && yarn install`), Node >= 22.12.0.

## Change type → what to run

| Change touches                                                                                                   | Run                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/xlsx/xform/**`, `lib/doc/**`, `lib/utils/**`                                                                | `yarn test:unit && yarn test:integration` (no build needed)                                                                                                                                                                                                                                                                |
| Public API (new/changed methods, options, model fields)                                                          | above, PLUS update `index.d.ts` (hand-maintained) and `yarn tsc --noEmit -p tsconfig.check-types.json`                                                                                                                                                                                                                     |
| `scripts/build.js`, `lib/exceljs.browser.js`, `lib/exceljs.bare.js`, `scripts/shims/**`, anything browser-facing | `yarn test:browser` (builds first; one-time setup `yarn playwright install chromium`) and `yarn build && yarn test:dist`                                                                                                                                                                                                   |
| `lib/stream/xlsx/**` (streaming reader/writer)                                                                   | `yarn test:integration && yarn test:end-to-end` — streaming coverage is spread across `spec/integration/` (workbook-xlsx-reader via `spec/utils/test-workbook-reader.js`, workbook-xlsx-writer/, worksheet-xlsx-writer, `issues/*streaming*`, `pr/test-pr-1431`) and `express.spec.js` streams over HTTP (fixed port 3003) |
| `excel.js` entry, `lib/exceljs.nodejs.js`, `package.json` dependencies                                           | `yarn test:full`                                                                                                                                                                                                                                                                                                           |

Fast dev loop: `yarn test:unit && yarn test:integration` — runs straight off `lib/` source, no build.

Single spec file:

- unit: `yarn mocha --require spec/config/setup.js --require spec/config/setup-unit.js spec/unit/path/to/foo.spec.js`
- integration/e2e: `yarn mocha --require spec/config/setup.js spec/integration/path/to/foo.spec.js`

## When a build is required

`yarn build` (esbuild → `dist/`) is needed only for: `test:browser` (its script builds anyway),
`test:dist`, and any `EXCEL_BUILD=cjs` run. Never edit `dist/` — generated and gitignored.

## The verquire / EXCEL_BUILD matrix

Specs load library code via the global `verquire('path/under/lib')` (`spec/utils/verquire.js`,
registered in `spec/config/setup.js`). Default: `lib/` source. With `EXCEL_BUILD=cjs` it loads
`dist/cjs/` instead — run `yarn build` first or you are testing stale code. Shortcuts:
`yarn test:unit:cjs`, `yarn test:integration:cjs`, `yarn test:end-to-end:cjs`, `yarn test:cjs`
(full). Run the cjs matrix only when the change could interact with the esbuild transpile (new
files, entry wiring, syntax edge cases) or pre-release; day-to-day source runs suffice. New spec
files MUST use `verquire`, never `require`, for anything under `lib/`.

## Smoke test: prove behavior end-to-end

Passing suites are not proof for a behavioral claim. Write then read a real workbook exercising
the change (`spec/out/*` and `*.xlsx` are gitignored):

```bash
mkdir -p spec/out && node -e "
const ExcelJS = require('./excel.js');
(async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Smoke');
  ws.getCell('A1').value = 42;   // <-- exercise the changed feature here
  await wb.xlsx.writeFile('spec/out/smoke.xlsx');
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.readFile('spec/out/smoke.xlsx');
  console.log(JSON.stringify(wb2.getWorksheet('Smoke').getCell('A1').value));
})().catch((e) => { console.error(e); process.exit(1); });
"
```

`require('./excel.js')` loads `lib/` source directly — no build. For write-path changes also
unzip and inspect the produced XML (see the xlsx-debug skill). Read behavior = parse pass PLUS a
separate reconcile pass (`lib/xlsx/xlsx.js`) — a round-trip through `readFile` exercises both;
asserting on parse output alone can hide reconcile bugs.

## Done checklist

- Right tier(s) above pass
- `yarn lint` (zero warnings enforced) and `yarn format:check` pass (`yarn format` to fix;
  Prettier owns style: no semicolons, single quotes)
- Public API change: `index.d.ts` updated + `yarn tsc --noEmit -p tsconfig.check-types.json`
- Smoke script demonstrates the actual behavior
- Do NOT use `yarn test:typescript` — it is not part of CI and requires a prior `yarn build`
  (`index.ts` imports `./dist/cjs`); CI's type check is the tsc command above
- Do NOT bump `package.json` version (the release flow owns it — see the release skill)
