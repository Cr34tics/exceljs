---
name: xlsx-debug
description: Playbook for debugging xlsx read/write issues — Excel says the file is corrupt or repairs it, wrong cell value/style/format/date after round-trip, missing hyperlinks/merges/comments, inspecting xlsx internals, or diffing two workbooks. Covers unzipping an .xlsx, which XML parts matter, pretty-printing and diffing parts, and mapping an XML element to its xform class.
---

# Debugging xlsx files

An .xlsx is a zip of XML parts. Debug by reading the actual XML, not by guessing from library code.

## Unzip / list parts

```bash
mkdir -p /tmp/wb && unzip -o file.xlsx -d /tmp/wb
# or without unzip:
python3 -m zipfile -e file.xlsx /tmp/wb
python3 -m zipfile -l file.xlsx
```

## Parts that matter

- `xl/workbook.xml` — sheet list (name, sheetId, r:id), defined names, views
- `xl/worksheets/sheet1.xml` — rows and cells (`<c r="A1" s="styleIdx" t="type">`), merges, data validations, col widths
- `xl/styles.xml` — numFmts, fonts, fills, borders, cellXfs; a cell's `s=` is a 0-based index into cellXfs
- `xl/sharedStrings.xml` — cells with `t="s"` hold an index into the `<si>` entries here
- `xl/_rels/workbook.xml.rels` and `xl/worksheets/_rels/sheet1.xml.rels` — wire sheets, hyperlinks, tables, drawings, comments
- `[Content_Types].xml` — every part must be declared here or Excel "repairs" the file
- `xl/tables/`, `xl/drawings/`, `xl/comments*.xml`, `xl/pivotTables/` — feature-specific

## Pretty-print (parts are written as one line)

```bash
python3 -c "import sys,xml.dom.minidom as m; print(m.parse(sys.argv[1]).toprettyxml(indent='  '))" /tmp/wb/xl/worksheets/sheet1.xml
# or: xmllint --format <file>
```

## Diff two workbooks part-by-part

Extract both to /tmp/a and /tmp/b, then compare pretty-printed parts:

```bash
pp() { python3 -c "import sys,xml.dom.minidom as m; print(m.parse(sys.argv[1]).toprettyxml(indent='  '))" "$1"; }
(cd /tmp/a && find . -name '*.xml' -o -name '*.rels') | while read -r f; do
  diff <(pp "/tmp/a/$f") <(pp "/tmp/b/$f") >/dev/null 2>&1 || echo "DIFFERS: $f"
done
```

Then pretty-diff the differing parts individually. Zip entry order and metadata are irrelevant;
only XML content matters.

## Map an XML element back to its xform

One transformer class per element under `lib/xlsx/xform/**` (book/ core/ sheet/ style/ strings/
drawing/ table/ comment/ pivot-table/ simple/). Find the handler by tag name:

```bash
grep -rn "'dataValidation'" lib/xlsx/xform/   # tags appear in parseOpen/render/this.map
```

Parents register children in `this.map` — see the `lib/xlsx/xform/sheet/worksheet-xform.js`
constructor. Which xform handles which zip part, and the read-side reconcile pass, live in
`lib/xlsx/xlsx.js`.

GOTCHA: read behavior is `parseOpen/parseText/parseClose` PLUS a separate `reconcile()` pass
(styleId→style, ssId→string, numFmt→Date via `utils.isDateFmt`, shared formulas,
hyperlinks/comments). If the raw parsed value is right but the final model is wrong, suspect
reconcile, not parse.

## Reference workbook

`spec/integration/data/gold.xlsx` is the gold-standard round-trip file (assertions in
`spec/integration/gold.spec.js`) — a known-good example of most features. More fixtures:
`spec/integration/data/`.

## Generate a test workbook with the library

```bash
node -e "
const ExcelJS = require('./excel.js');
(async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  ws.getCell('A1').value = 'text';
  ws.getCell('A2').value = { formula: 'A1', result: 'text' };
  ws.getCell('A3').value = new Date(); ws.getCell('A3').numFmt = 'yyyy-mm-dd';
  await wb.xlsx.writeFile('/tmp/generated.xlsx');
})();
"
```

Then unzip and inspect what the library actually wrote. To see what Excel/LibreOffice writes for
a feature, save the same content in the app and diff part-by-part.

## Typical workflows

- Excel repairs our output: diff our file against a minimal app-saved file with the same feature;
  check `[Content_Types].xml` and the `_rels` first.
- Wrong value on read: find the cell's raw XML, then trace parse (the xform) vs reconcile
  (`lib/xlsx/xlsx.js`).
- Style lost on round-trip: check the cell's `s=` index against `xl/styles.xml` cellXfs;
  write-side style ids are assigned in `prepare()` via `options.styles.addStyleModel`.
