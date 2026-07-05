# CLAUDE.md

`@cr34tics/exceljs` — hard fork of exceljs (xlsx/csv read/write), published to **GitHub Packages**
(npm.pkg.github.com), not public npm. Only remote is `origin`; there is no upstream sync. The fork
exists to retire abandoned deps (jszip→fflate, archiver@8, unzipper@0.12) and modernize tooling.
Node **>=22.12.0** is a hard floor (`excel.js` throws below it).
**README.md is still upstream's — do not trust it for setup or install instructions.**

## Commands

| Task              | Command                                                               |
| ----------------- | --------------------------------------------------------------------- |
| Setup             | `corepack enable && yarn install` (Yarn 4 via Corepack)               |
| **Fast dev loop** | `yarn test:unit && yarn test:integration` — needs **no build**        |
| Single spec file  | `yarn mocha --require spec/config/setup.js spec/unit/path/to.spec.js` |
| Build             | `yarn build` (esbuild → `dist/` browser bundles + `dist/cjs/`)        |
| Full suite        | `yarn test:full` (build + unit + integration + e2e + browser)         |
| Browser tests     | one-time `yarn playwright install chromium`, then `yarn test:browser` |
| Lint              | `yarn lint` — **zero warnings tolerated**; `yarn lint:fix` to autofix |
| Format            | `yarn format` (Prettier owns formatting)                              |
| Type check        | `yarn tsc --noEmit -p tsconfig.check-types.json` (what CI runs)       |

- Do **not** use `yarn test:typescript` — it requires a prior build and is currently broken;
  CI type-checks only via tsc above.
- No git hooks run (husky leftovers are inert) — lint and format yourself before pushing.
- e2e specs bind fixed port 3003; a busy port causes unrelated-looking failures.
- `.yarnrc.yml` rejects npm packages published <7 days ago (`npmMinimalAgeGate`) — a brand-new
  release of a dependency will fail to install; wait or preapprove, don't fight it.

## Hard rules

- Specs load library code via the global `verquire('xlsx/xform/...')` (path relative to `lib/`),
  **never** `require('../../lib/...')` — verquire switches between `lib/` source and `dist/cjs/`
  under `EXCEL_BUILD=cjs` (`spec/utils/verquire.js`).
- Never edit `dist/` — generated, gitignored.
- Any public API change must also update the **hand-maintained `index.d.ts`** (CI type-checks it).
- Never bump `package.json` version in a PR — the release workflow takes the version from the
  GitHub Release tag and opens a sync PR afterwards.
- Do not reintroduce jszip/tmp/uuid/got (deliberately removed); do not replace
  events/buffer/stream-browserify/saxes (deliberately kept browser deps).
- Style: **no semicolons**, single quotes, trailing commas, no max line length (`.prettierrc` +
  Prettier defaults). ESLint bans `for-in`, labeled statements, `with`, bitwise ops, and `await`
  in loops; `console.warn` is the only console call allowed.

## Architecture map

- All of `lib/` is CommonJS. Node entry `excel.js` → `lib/exceljs.nodejs.js`; browser entry
  `lib/exceljs.browser.js`.
- `lib/doc/` — public document model (workbook, worksheet, row, cell, table, pivot-table, ...).
  Every class exposes a plain `.model` — the canonical serialization, documented in **MODEL.md**.
- `lib/xlsx/xform/**` — one transformer class per XML element (interface: `base-xform.js`):
  - Write: `prepare(model, options)` (assigns styleIds, shared-string ids, formula `si`)
    → `render(xmlStream, model)`.
  - Read: SAX `parseOpen/parseText/parseClose` → a **separate `reconcile(model, options)` pass**
    (`lib/xlsx/xlsx.js`) resolving styleId→style, ssId→string, dates, shared-formula slaves.
  - **GOTCHA: changing read behavior usually requires editing BOTH parse and reconcile.**
  - Compose via `composite-xform.js` (`this.map`), `list-xform.js`, `simple/` wrappers.
    Reference examples: trivial `core/relationship-xform.js`, full lifecycle
    `sheet/data-validations-xform.js`, composite `sheet/worksheet-xform.js`.
- `lib/stream/xlsx/` does **not** mirror the doc API: WorkbookReader/WorksheetReader are
  EventEmitters with `'emit'|'cache'|'ignore'` resource options; the streaming writer requires an
  explicit `commit()` on row/worksheet/workbook.
- Reuse, don't reimplement (`lib/utils/`): `col-cache.js` (all cell-address math),
  `xml-stream.js` (the only sanctioned XML writer), `under-dash.js` (imported as `_`; there is no
  real lodash), `utils.js` (date↔excel, xmlEncode/Decode), `shared-strings.js`, `parse-sax.js`,
  `shared-formula.js`.

## Tests

- Mocha + Chai; `spec/config/setup.js` registers globals: `expect`, `verquire`, dirty-chai,
  chai-xml, chai-datetime.
- Layout: `spec/unit` (fast), `spec/integration` (real files; `gold.spec.js` round-trips
  `gold.xlsx` — the compatibility gold standard), `spec/end-to-end`, `spec/dist` (built bundles).
- xform specs use the shared harness `spec/unit/xlsx/xform/test-xform-helper.js`: export
  expectation objects `{title, create(), initialModel, preparedModel, parsedModel, xml, tests: ['prepare', 'render', 'parse', ...]}`;
  XML is compared whitespace-insensitively.
- Top-level `test/` is legacy manual scripts — the real suite lives in `spec/`.

## Conventions

- Conventional Commits (`feat:`, `fix:`, `chore:`, `chore(deps):`, `ci:`, `perf:`, `refactor:`,
  `docs:`); branches `type/kebab-description`; PRs land as merge commits (not squash).
- CI: Node 22/24/26 × ubuntu/macos/windows; browser tests only on Linux + Node 24; separate
  lint/type-check/benchmark jobs.

## Skills & docs

Step-by-step workflows live in project skills — use them instead of improvising:
`.claude/skills/verify` (verify a change end-to-end), `.claude/skills/xlsx-debug` (debug xlsx
read/write issues), `.claude/skills/add-xlsx-feature` (new xlsx feature via the xform workflow),
`.claude/skills/release` (cut and publish a release).

Reference docs: `MODEL.md` (the `.model` contract), `UPGRADE-4.0.md` (historical API changes).
