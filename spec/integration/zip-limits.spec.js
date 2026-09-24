const fs = require('fs')
const os = require('os')
const path = require('path')
const { Readable } = require('stream')
const { unzipSync, zipSync } = require('fflate')

const ExcelJS = verquire('exceljs')

const LIMIT_CODE = 'ERR_ZIP_LIMIT_EXCEEDED'
const MB = 1024 * 1024

async function writeWorkbook(rows = 1) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('sheet')
  for (let i = 1; i <= rows; i++) {
    ws.getCell(`A${i}`).value = `row ${i}`
    ws.getCell(`B${i}`).value = i
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

// Re-zips an xlsx, letting `edit` add, replace or reorder entries
function rezip(buffer, edit) {
  const files = edit(unzipSync(buffer))
  return Buffer.from(zipSync(files, { level: 9 }))
}

// Adds a highly compressible entry, as a zip bomb would
function withBomb(buffer, size, name = 'xl/media/bomb.bin') {
  return rezip(buffer, (files) => ({ ...files, [name]: new Uint8Array(size) }))
}

// Rewrites the uncompressed size declared in the central directory, which is
// what the buffered reader trusts when allocating output
function withDeclaredSize(buffer, entryName, size) {
  const out = Buffer.from(buffer)
  for (let i = out.length - 46; i >= 0; i--) {
    if (out.readUInt32LE(i) === 0x02014b50) {
      const nameLength = out.readUInt16LE(i + 28)
      const name = out.toString('latin1', i + 46, i + 46 + nameLength)
      if (name === entryName) {
        out.writeUInt32LE(size, i + 24)
        return out
      }
    }
  }
  throw new Error(`entry not found: ${entryName}`)
}

async function expectLimitError(promise, pattern) {
  let error
  try {
    await promise
  } catch (e) {
    error = e
  }
  expect(error, 'expected a zip limit error').to.be.an.instanceOf(Error)
  expect(error.code).to.equal(LIMIT_CODE)
  expect(error.message).to.match(pattern)
}

async function streamRead(input, options) {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(input, options)
  let rows = 0
  for await (const worksheet of reader) {
    for await (const row of worksheet) {
      if (row) rows++
    }
  }
  return rows
}

describe('zip decompression limits', () => {
  let small
  before(async () => {
    small = await writeWorkbook()
  })

  describe('xlsx.load', () => {
    it('reads normally without limits', async () => {
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(withBomb(small, 8 * MB))
      expect(wb.getWorksheet('sheet').getCell('A1').value).to.equal('row 1')
    })

    it('reads normally within the limits', async () => {
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(small, {
        maxEntries: 100,
        maxUncompressedSize: 10 * MB,
      })
      expect(wb.getWorksheet('sheet').getCell('B1').value).to.equal(1)
    })

    it('rejects an archive whose uncompressed size exceeds maxUncompressedSize', async () => {
      const bomb = withBomb(small, 8 * MB)
      expect(bomb.length).to.be.below(MB)
      await expectLimitError(
        new ExcelJS.Workbook().xlsx.load(bomb, { maxUncompressedSize: 4 * MB }),
        /maxUncompressedSize/,
      )
    })

    it('rejects a huge declared size before allocating it', async () => {
      const lying = withDeclaredSize(
        withBomb(small, 1024),
        'xl/media/bomb.bin',
        0xfffffff0,
      )
      await expectLimitError(
        new ExcelJS.Workbook().xlsx.load(lying, { maxUncompressedSize: MB }),
        /maxUncompressedSize/,
      )
    })

    it('rejects an archive with more than maxEntries entries', async () => {
      const entries = Object.keys(unzipSync(small)).length
      await expectLimitError(
        new ExcelJS.Workbook().xlsx.load(small, { maxEntries: entries - 1 }),
        /maxEntries/,
      )
      await new ExcelJS.Workbook().xlsx.load(small, { maxEntries: entries })
    })

    it('applies the limits to xlsx.read', async () => {
      await expectLimitError(
        new ExcelJS.Workbook().xlsx.read(
          Readable.from([withBomb(small, 8 * MB)]),
          { maxUncompressedSize: 4 * MB },
        ),
        /maxUncompressedSize/,
      )
    })

    it('validates the limit options', async () => {
      let error
      try {
        await new ExcelJS.Workbook().xlsx.load(small, { maxEntries: -1 })
      } catch (e) {
        error = e
      }
      expect(error).to.be.an.instanceOf(TypeError)
    })
  })

  describe('stream WorkbookReader', () => {
    let large
    before(async () => {
      large = await writeWorkbook(5000)
    })

    it('reads normally within the limits', async () => {
      const rows = await streamRead(Readable.from([large]), {
        maxEntries: 100,
        maxUncompressedSize: 10 * MB,
      })
      expect(rows).to.equal(5000)
    })

    it('rejects a worksheet that inflates past maxUncompressedSize', async () => {
      await expectLimitError(
        streamRead(Readable.from([large]), { maxUncompressedSize: 64 * 1024 }),
        /maxUncompressedSize/,
      )
    })

    it('rejects a worksheet buffered before the shared strings', async () => {
      // Sheets that precede sharedStrings/rels are buffered for later parsing
      const reordered = rezip(large, (files) => {
        const sheet = 'xl/worksheets/sheet1.xml'
        const { [sheet]: sheetXml, ...rest } = files
        return { [sheet]: sheetXml, ...rest }
      })
      await expectLimitError(
        streamRead(Readable.from([reordered]), {
          maxUncompressedSize: 64 * 1024,
        }),
        /maxUncompressedSize/,
      )
    })

    it('rejects a bomb in a part that is not parsed', async () => {
      // styles are ignored by default but still inflated while draining
      const bomb = withBomb(small, 8 * MB, 'xl/styles.xml')
      await expectLimitError(
        streamRead(Readable.from([bomb]), { maxUncompressedSize: 4 * MB }),
        /maxUncompressedSize/,
      )
    })

    it('does not count media, which is drained without buffering', async () => {
      const rows = await streamRead(Readable.from([withBomb(small, 8 * MB)]), {
        maxUncompressedSize: MB,
      })
      expect(rows).to.equal(1)
    })

    it('rejects an archive with more than maxEntries entries', async () => {
      await expectLimitError(
        streamRead(Readable.from([small]), { maxEntries: 2 }),
        /maxEntries/,
      )
    })

    it('rejects when reading from a file path', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exceljs-zip-limits-'))
      const filename = path.join(dir, 'large.xlsx')
      fs.writeFileSync(filename, large)
      try {
        await expectLimitError(
          streamRead(filename, { maxUncompressedSize: 64 * 1024 }),
          /maxUncompressedSize/,
        )
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
