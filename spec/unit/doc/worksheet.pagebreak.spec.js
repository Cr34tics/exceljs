const Excel = verquire('exceljs')

describe('Worksheet', () => {
  describe('Page Breaks', () => {
    it('adds multiple row breaks', () => {
      const wb = new Excel.Workbook()
      const ws = wb.addWorksheet('blort')

      // initial values
      ws.getCell('A1').value = 'A1'
      ws.getCell('B1').value = 'B1'
      ws.getCell('A2').value = 'A2'
      ws.getCell('B2').value = 'B2'
      ws.getCell('A3').value = 'A3'
      ws.getCell('B3').value = 'B3'

      let row = ws.getRow(1)
      row.addPageBreak()
      row = ws.getRow(2)
      row.addPageBreak()

      expect(ws.rowBreaks.length).to.equal(2)
    })

    it('adds multiple column breaks', () => {
      const wb = new Excel.Workbook()
      const ws = wb.addWorksheet('blort')

      ws.getColumn(2).addPageBreak()
      ws.getColumn(4).addPageBreak(1, 10)

      expect(ws.colBreaks.length).to.equal(2)
      expect(ws.colBreaks[0]).to.deep.equal({ id: 2, max: 1048575, man: 1 })
      // 1-based top/bottom -> 0-based min/max; top === 1 -> min omitted
      expect(ws.colBreaks[1]).to.deep.equal({ id: 4, max: 9, man: 1 })
    })
  })
})
