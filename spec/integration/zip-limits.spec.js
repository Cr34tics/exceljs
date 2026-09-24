const fs = require('fs')
const os = require('os')
const path = require('path')
const { Readable } = require('stream')
const { strToU8, unzipSync, zipSync } = require('fflate')

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

// Pads an xlsx with stored, empty directory records until it has `total`
// entries: both readers count them, and load() skips them, which keeps the
// fixture cheap to build and to read
function withEntryCount(buffer, total) {
  return rezip(buffer, (files) => {
    const padded = { ...files }
    for (let i = Object.keys(files).length; i < total; i++) {
      padded[`xl/media/pad${i}`] = [{}, { level: 0 }]
    }
    return padded
  })
}

// Adds `copies` more central directory records for `entryName`, all pointing
// at its one compressed body, the way overlapping-entry zip bombs are built
function withOverlappingEntries(buffer, entryName, copies) {
  const eocd = buffer.length - 22
  const count = buffer.readUInt16LE(eocd + 10)
  const cdSize = buffer.readUInt32LE(eocd + 12)
  const cdOffset = buffer.readUInt32LE(eocd + 16)
  let record
  for (let i = cdOffset; i < cdOffset + cdSize;) {
    const nameLength = buffer.readUInt16LE(i + 28)
    const length =
      46 +
      nameLength +
      buffer.readUInt16LE(i + 30) +
      buffer.readUInt16LE(i + 32)
    if (buffer.toString('latin1', i + 46, i + 46 + nameLength) === entryName) {
      record = buffer.subarray(i, i + length)
    }
    i += length
  }
  if (!record) throw new Error(`entry not found: ${entryName}`)
  const trailer = Buffer.from(buffer.subarray(eocd))
  trailer.writeUInt16LE(count + copies, 8)
  trailer.writeUInt16LE(count + copies, 10)
  trailer.writeUInt32LE(cdSize + copies * record.length, 12)
  return Buffer.concat([
    buffer.subarray(0, cdOffset + cdSize),
    ...Array(copies).fill(record),
    trailer,
  ])
}

// Cuts an xlsx off halfway through an entry's compressed data, as an
// interrupted upload would
function truncatedIn(buffer, entryName) {
  const zipped = rezip(buffer, (files) => files)
  let offset = 0
  while (zipped.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = zipped.readUInt32LE(offset + 18)
    const nameLength = zipped.readUInt16LE(offset + 26)
    const name = zipped.toString(
      'latin1',
      offset + 30,
      offset + 30 + nameLength,
    )
    const dataStart =
      offset + 30 + nameLength + zipped.readUInt16LE(offset + 28)
    if (name === entryName) {
      return zipped.subarray(0, dataStart + Math.ceil(compressedSize / 2))
    }
    offset = dataStart + compressedSize
  }
  throw new Error(`entry not found: ${entryName}`)
}

async function rejectionOf(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  return undefined
}

async function expectLimitError(promise, pattern) {
  const error = await rejectionOf(promise)
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
  let tooManyEntries
  before(async function () {
    this.timeout(30000)
    small = await writeWorkbook()
    tooManyEntries = withEntryCount(small, 10001)
  })

  describe('xlsx.load', () => {
    it('reads a highly compressible entry under the default limits', async () => {
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

    it('rejects entries that share compressed data', async () => {
      // Each copy declares a small size but inflates the whole body again
      const overlapping = withOverlappingEntries(
        withBomb(small, 8 * MB),
        'xl/media/bomb.bin',
        2,
      )
      await expectLimitError(
        new ExcelJS.Workbook().xlsx.load(overlapping),
        /overlap/,
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
      const invalid = [-1, NaN, '10']
      const errors = await Promise.all(
        invalid.map((maxEntries) =>
          new ExcelJS.Workbook().xlsx.load(small, { maxEntries }).then(
            () => undefined,
            (error) => error,
          ),
        ),
      )
      errors.forEach((error, i) => {
        expect(error, String(invalid[i])).to.be.an.instanceOf(TypeError)
      })
    })

    describe('defaults', () => {
      it('rejects a declared size over 1 GiB without any options', async () => {
        const lying = withDeclaredSize(
          withBomb(small, 1024),
          'xl/media/bomb.bin',
          0xfffffff0,
        )
        await expectLimitError(
          new ExcelJS.Workbook().xlsx.load(lying),
          /1073741824 bytes \(maxUncompressedSize\)/,
        )
      })

      it('rejects more than 10000 entries without any options', async () => {
        await expectLimitError(
          new ExcelJS.Workbook().xlsx.load(tooManyEntries),
          /more than 10000 entries/,
        )
      })

      it('can be disabled with null', async () => {
        const wb = new ExcelJS.Workbook()
        await wb.xlsx.load(tooManyEntries, { maxEntries: null })
        expect(wb.getWorksheet('sheet').getCell('A1').value).to.equal('row 1')
      })
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

    it('rejects more than 10000 entries by default', async function () {
      // the reader walks all 10000 entries before rejecting
      this.timeout(30000)
      await expectLimitError(
        streamRead(Readable.from([tooManyEntries])),
        /more than 10000 entries/,
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

    it('rejects an archive cut off inside a part it drains or reads', async () => {
      // unzipper reports the truncation on the zip stream only; styles.xml is
      // drained under the default styles: 'ignore', the sheet is read
      const errors = await Promise.all(
        ['xl/styles.xml', 'xl/worksheets/sheet1.xml'].map((part) =>
          rejectionOf(streamRead(Readable.from([truncatedIn(small, part)]))),
        ),
      )
      errors.forEach((error) => {
        expect(error).to.be.an.instanceOf(Error)
      })
    })

    it('rejects when the file cannot be read', async () => {
      const error = await rejectionOf(
        streamRead(path.join(os.tmpdir(), 'exceljs-missing', 'none.xlsx')),
      )
      expect(error && error.code).to.equal('ENOENT')
    })

    describe('closes a file it opened', () => {
      let dir
      let filename
      before(() => {
        const files = unzipSync(small)
        // A ~2 MB sheet stored uncompressed after the parts that let the
        // reader stream it, so reading stops long before the file is consumed
        const rows = []
        for (let r = 1; r <= 40000; r++) {
          rows.push(`<row r="${r}"><c r="A${r}"><v>${r}</v></c></row>`)
        }
        const sheet = Buffer.from(files['xl/worksheets/sheet1.xml'])
          .toString()
          .replace(
            /<sheetData>.*<\/sheetData>|<sheetData\/>/s,
            `<sheetData>${rows.join('')}</sheetData>`,
          )
        const {
          'xl/_rels/workbook.xml.rels': rels,
          'xl/sharedStrings.xml': strings,
          'xl/workbook.xml': workbook,
          'xl/worksheets/sheet1.xml': _unused,
          ...rest
        } = files
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exceljs-zip-limits-'))
        filename = path.join(dir, 'streamed.xlsx')
        const ordered = {
          'xl/_rels/workbook.xml.rels': rels,
          'xl/sharedStrings.xml': strings,
          'xl/workbook.xml': workbook,
          ...rest,
          'xl/worksheets/sheet1.xml': strToU8(sheet),
        }
        fs.writeFileSync(filename, zipSync(ordered, { level: 0 }))
      })
      after(() => {
        fs.rmSync(dir, { recursive: true, force: true })
      })

      it('after a limit error raised while iterating a worksheet', async () => {
        const reader = new ExcelJS.stream.xlsx.WorkbookReader(filename, {
          maxUncompressedSize: 64 * 1024,
        })
        let rows = 0
        const error = await rejectionOf(
          (async () => {
            for await (const worksheet of reader) {
              for await (const row of worksheet) {
                if (row) rows++
              }
            }
          })(),
        )
        expect(error && error.code).to.equal(LIMIT_CODE)
        expect(rows).to.be.above(0)
        expect(reader.stream.destroyed).to.equal(true)
      })

      it('when the consumer stops early', async () => {
        const reader = new ExcelJS.stream.xlsx.WorkbookReader(filename, {})
        for await (const worksheet of reader) {
          for await (const row of worksheet) {
            expect(row).to.be.ok()
            break
          }
          break
        }
        expect(reader.stream.destroyed).to.equal(true)
      })
    })

    it('reports a limit hit in hyperlinks without an unhandled rejection', async () => {
      const wb = new ExcelJS.Workbook()
      const ws = wb.addWorksheet('sheet')
      for (let i = 1; i <= 200; i++) {
        ws.getCell(`A${i}`).value = {
          text: `link ${i}`,
          hyperlink: `https://example.com/${i}`,
        }
      }
      const rels = 'xl/worksheets/_rels/sheet1.xml.rels'
      let relsSize
      // Put the sheet rels first so the limit is crossed while they stream
      const buffer = rezip(
        Buffer.from(await wb.xlsx.writeBuffer()),
        ({ [rels]: relsXml, ...rest }) => {
          relsSize = relsXml.length
          return { [rels]: relsXml, ...rest }
        },
      )

      const unhandled = []
      const onUnhandled = (error) => unhandled.push(error)
      process.on('unhandledRejection', onUnhandled)
      try {
        const reader = new ExcelJS.stream.xlsx.WorkbookReader(
          Readable.from([buffer]),
          { hyperlinks: 'emit', maxUncompressedSize: relsSize - 1 },
        )
        // README "Readable stream" pattern: no 'error' listener on hyperlinks
        reader.on('hyperlinks', (hyperlinks) => {
          hyperlinks.on('hyperlink', () => {})
          hyperlinks.read()
        })
        const error = await new Promise((resolve) => {
          reader.on('error', resolve)
          reader.on('end', () => resolve(undefined))
          reader.read()
        })
        await new Promise((resolve) => setImmediate(resolve))
        expect(error, 'expected an error event').to.be.an.instanceOf(Error)
        expect(error.code).to.equal(LIMIT_CODE)
        expect(unhandled).to.have.length(0)
      } finally {
        process.removeListener('unhandledRejection', onUnhandled)
      }
    })
  })
})
