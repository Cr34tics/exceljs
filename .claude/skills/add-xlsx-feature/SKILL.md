---
name: add-xlsx-feature
description: Step-by-step for adding support for a new XLSX/OOXML feature or XML element via the xform pattern — extending the doc model, picking the right xform base class, wiring prepare/render/parse/reconcile, registering in the parent's map, updating index.d.ts, and writing the xform spec with test-xform-helper plus an integration round-trip test.
---

# Adding an XLSX feature

## 0. Research the XML shape first

Save a file with the feature from Excel/LibreOffice, unzip it, and read the real XML (see the
xlsx-debug skill). `spec/integration/data/gold.xlsx` is a known-good reference.
Element/attribute names come from ECMA-376 — match them exactly.

## 1. Extend the document model (lib/doc/\*)

Add the property to the relevant class (`worksheet.js`, `workbook.js`, `cell.js`, `row.js`,
`column.js`, `table.js`, ...) and make sure it round-trips through `.model` (get/set). Update
`MODEL.md` if the canonical model shape changes. Reuse `lib/utils/col-cache.js` for any address
math and `lib/utils/under-dash.js` (`_`) for utility functions — no lodash.

## 2. Pick the xform base (lib/xlsx/xform/)

- Single element, attributes only → extend `base-xform.js`. Reference:
  `lib/xlsx/xform/core/relationship-xform.js` (trivial, complete).
- Element with heterogeneous children → extend `composite-xform.js`; declare
  `this.map = {childTag: childXform}`; parseOpen/parseClose defaults handle delegation.
  Reference: `lib/xlsx/xform/sheet/worksheet-xform.js`.
- Repeated homogeneous children → `list-xform.js` (`new ListXform({tag, count, childXform})`) —
  see the worksheet-xform constructor for many examples.
- Single-value leaf → `simple/` wrappers: integer-/float-/string-/boolean-/date-xform
  (`new IntegerXform({tag, attr})`).
- Constant XML block → `static-xform.js`.

Full lifecycle reference (prepare/render/parse/reconcile in one file):
`lib/xlsx/xform/sheet/data-validations-xform.js`.

## 3. Implement the lifecycle (interface documented in lib/xlsx/xform/base-xform.js)

- `prepare(model, options)`: pre-write mutation — style ids via `options.styles.addStyleModel`,
  shared string ids, formula `si`, collecting merges/hyperlinks/comments.
- `render(xmlStream, model)`: use ONLY `lib/utils/xml-stream.js`
  (openNode/addAttribute/leafNode/writeText/closeNode, addRollback/commit). Use the
  `BaseXform.toAttribute/toBoolAttribute/toIntAttribute` helpers for defaults.
- `parseOpen(node)/parseText(text)/parseClose(name)`: SAX events; `parseClose` must return false
  when the root tag closes (that pops this xform off the parent's parser).
- `reconcile(model, options)`: post-parse resolution (opposite of prepare).

GOTCHA: parse and reconcile are a pair. Reads run per-part `parseStream()` and then a SEPARATE
reconcile pass (`lib/xlsx/xlsx.js` `reconcile()`). Anything involving styleId→style, ssId→string,
dates, or shared formulas needs BOTH edits, and reconcile options must be threaded from `xlsx.js`.

## 4. Register it

- Add to the parent xform's `this.map` (e.g. `worksheet-xform.js` constructor) AND to its
  `render()`/`prepare()` sequence — map registration alone only wires parsing.
- New zip part (rare): also wire `lib/xlsx/xlsx.js` (write + read + reconcile), content-types
  (`lib/xlsx/xform/core/content-types-xform.js`) and rels — otherwise Excel repairs the file.
- Streaming mirror: `lib/stream/xlsx/` does NOT mirror the doc API. `worksheet-writer.js` imports
  many xforms directly — worksheet-level features usually need wiring there too (and in
  `workbook-writer.js` for workbook-level parts).

## 5. Public API surface

Update the hand-maintained `index.d.ts`; check with
`yarn tsc --noEmit -p tsconfig.check-types.json`.

## 6. Unit spec (`spec/unit/xlsx/xform/<group>/<name>-xform.spec.js`)

Use the shared harness. Exact expectation shape (each test name pulls specific fields; missing
ones throw `Expectation missing required field`):

```js
const testXformHelper = require('../test-xform-helper')
const MyXform = verquire('xlsx/xform/sheet/my-xform')

const expectations = [
  {
    title: 'case name',
    create: () => new MyXform(),
    initialModel: {...},    // for 'prepare', 'prepare-render'
    preparedModel: {...},   // for 'prepare' (expected), 'render', 'renderIn'
    xml: '<myTag a="1"/>',  // for render/parse tests; compared whitespace-insensitively (chai-xml)
    parsedModel: {...},     // for 'parse', 'parseIn', 'reconcile' (input)
    reconciledModel: {...}, // for 'reconcile' (expected)
    options: {...},         // passed to prepare()/reconcile(); use fakes (see row-xform.spec.js)
    tests: ['prepare', 'render', 'renderIn', 'prepare-render', 'parse', 'parseIn', 'reconcile'],
  },
]
describe('MyXform', () => { testXformHelper(expectations) })
```

Notes: only include fields the listed tests need; alias identical stages with a getter
(`get parsedModel() { return this.preparedModel }`); `renderIn`/`parseIn` wrap your xform in a
composite and require it to expose `tag`; `options` is shared (not cloned) across the tests of one
expectation, so stateful fakes persist. Examples: `simple/integer-xform.spec.js` (minimal),
`sheet/data-validations-xform.spec.js` (render+parse), `sheet/row-xform.spec.js` (full lifecycle
with options fakes: fakeStyles, SharedStringsXform, fakeHyperlinkMap).

## 7. Integration round-trip test

Add to `spec/integration/` (pattern: write a workbook using the new model API to
`spec/out/*.test.xlsx`, read it back, deep-assert the model — see `spec/integration/gold.spec.js`
and `spec/integration/issues/` for shape). Load the library with `verquire('exceljs')`, never
`require`.

## 8. Verify

Run the verify skill: `yarn test:unit && yarn test:integration`, lint/format, type check, and the
write-then-read smoke script.
