const ExcelJS = verquire('exceljs')

// Round-trips the features hardened while emptying the legacy TODO.txt:
//  - column page breaks (colBreaks) + the row-break read path
//  - print options (showGridLines / horizontalCentered)
//  - pageSetup.cellComments: 'asDisplayed'
//  - table displayName
describe('worksheet feature round-trips', () => {
  it('preserves row/column breaks, print options, cellComments and table displayName', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('sheet')

    // page breaks
    ws.getRow(1).addPageBreak()
    ws.getColumn(1).addPageBreak()

    // print options + cellComments
    ws.pageSetup.showGridLines = true
    ws.pageSetup.horizontalCentered = true
    ws.pageSetup.cellComments = 'asDisplayed'

    // a table carrying an explicit displayName
    ws.addTable({
      name: 'MyTable',
      displayName: 'MyDisplayName',
      ref: 'A1',
      columns: [{ name: 'Name' }, { name: 'Value' }],
      rows: [['foo', 1]],
    })

    const buffer = await wb.xlsx.writeBuffer()

    const wb2 = new ExcelJS.Workbook()
    await wb2.xlsx.load(buffer)
    const ws2 = wb2.getWorksheet('sheet')

    expect(ws2.rowBreaks.length).to.equal(1)
    expect(ws2.rowBreaks[0].id).to.equal(1)
    expect(ws2.colBreaks.length).to.equal(1)
    expect(ws2.colBreaks[0].id).to.equal(1)

    expect(ws2.pageSetup.showGridLines).to.equal(true)
    expect(ws2.pageSetup.horizontalCentered).to.equal(true)
    expect(ws2.pageSetup.cellComments).to.equal('asDisplayed')

    const table2 = ws2.getTable('MyTable')
    expect(table2.displayName).to.equal('MyDisplayName')
  })
})
