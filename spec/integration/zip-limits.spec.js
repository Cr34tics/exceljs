const fs = require('fs')
const os = require('os')
const path = require('path')
const { Readable } = require('stream')
const { strToU8, unzipSync, zipSync } = require('fflate')

const ExcelJS = verquire('exceljs')
const { promiseImmediate } = verquire('utils/utils')
const unzipLimited = verquire('utils/unzip-limited')
const ZipLimits = verquire('utils/zip-limits')

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

// A zip64 archive whose one central directory record keeps its uncompressed
// size in a zip64 extra field: cut off by the end of the file, or holding
// `high` as the size's upper 32 bits in a field that declares `fieldLength`
// bytes
function withZip64Size(high, fieldLength = 8) {
  const truncated = high === undefined
  const name = Buffer.from('xl/media/x.bin')
  const record = Buffer.alloc(46 + name.length + (truncated ? 6 : 12))
  record.writeUInt32LE(0x02014b50, 0)
  record.writeUInt32LE(1, 20) // compressed size (stored)
  record.writeUInt32LE(0xffffffff, 24) // uncompressed size: see zip64 extra
  record.writeUInt16LE(name.length, 28)
  record.writeUInt16LE(truncated ? 6 : 12, 30) // extra field length
  name.copy(record, 46)
  record.writeUInt16LE(1, 46 + name.length) // zip64 extra field id
  // truncated: runs past the end
  record.writeUInt16LE(truncated ? 8 : fieldLength, 48 + name.length)
  if (!truncated) {
    record.writeUInt32LE(1, 50 + name.length)
    record.writeUInt32LE(high, 54 + name.length)
  }
  const recordOffset = 56 + 20 + 22
  const zip64End = Buffer.alloc(56)
  zip64End.writeUInt32LE(0x06064b50, 0)
  zip64End.writeUInt32LE(1, 32) // total entries
  zip64End.writeUInt32LE(recordOffset, 48) // central directory offset
  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(0x07064b50, 0) // zip64 end record at offset 0
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(recordOffset, 16)
  return Buffer.concat([zip64End, locator, end, record])
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

    it('counts every entry that shares compressed data', async () => {
      // Each copy inflates the whole body again, so each one counts
      const overlapping = withOverlappingEntries(
        withBomb(small, 8 * MB),
        'xl/media/bomb.bin',
        2,
      )
      await expectLimitError(
        new ExcelJS.Workbook().xlsx.load(overlapping, {
          maxUncompressedSize: 20 * MB,
        }),
        /maxUncompressedSize/,
      )
    })

    it('rejects a directory that claims more than maxEntries before walking it', async () => {
      const claimed = Buffer.from(small)
      const end = claimed.length - 22
      claimed.writeUInt16LE(60000, end + 8)
      claimed.writeUInt16LE(60000, end + 10)
      await expectLimitError(
        new ExcelJS.Workbook().xlsx.load(claimed, { maxEntries: 20 }),
        /maxEntries/,
      )
    })

    it('rejects a zip64 size that runs past the end of the data', async () => {
      // read as NaN, it would make every later limit check pass
      const error = await rejectionOf(
        new ExcelJS.Workbook().xlsx.load(withZip64Size()),
      )
      expect(error, 'expected the load to fail').to.be.an.instanceOf(Error)
      expect(error.cause.message).to.equal('invalid zip data')
    })

    it('rejects a zip64 size too large to hold exactly', async () => {
      // 2^53 + 1 would silently read as 2^53
      const zip = withZip64Size(0x200000)
      const loads = [
        new ExcelJS.Workbook().xlsx.load(zip),
        new ExcelJS.Workbook().xlsx.load(zip, {
          maxEntries: null,
          maxUncompressedSize: null,
        }),
      ]
      for (const error of await Promise.all(loads.map(rejectionOf))) {
        expect(error, 'expected the load to fail').to.be.an.instanceOf(Error)
        expect(error.cause.message).to.equal('invalid zip data')
      }
    })

    it('rejects a zip64 size that runs past its extra field', async () => {
      // the field declares 4 bytes, so the 8-byte size would take in 4 bytes
      // that aren't part of it
      const error = await rejectionOf(
        new ExcelJS.Workbook().xlsx.load(withZip64Size(0, 4)),
      )
      expect(error, 'expected the load to fail').to.be.an.instanceOf(Error)
      expect(error.cause.message).to.equal('invalid zip data')
    })

    it('reads in full an entry that under-declares its size, with no limits', () => {
      // fflate's unzipSync would silently cut it off at the declared size
      const lying = withDeclaredSize(
        withBomb(small, MB),
        'xl/media/bomb.bin',
        1,
      )
      const files = unzipLimited(
        lying,
        new ZipLimits({ maxEntries: null, maxUncompressedSize: null }),
      )
      expect(files['xl/media/bomb.bin'].length).to.equal(MB)
    })

    it('copies a stored entry instead of keeping a view of the archive', () => {
      const stored = Buffer.from(
        zipSync({ 'xl/media/a.bin': [new Uint8Array(16), { level: 0 }] }),
      )
      const files = unzipLimited(stored, new ZipLimits({}))
      expect(files['xl/media/a.bin'].buffer).not.to.equal(stored.buffer)
      expect(files['xl/media/a.bin'].length).to.equal(16)
    })

    it('stops inflating an entry that under-declares its size', async () => {
      // Declares 1 byte but inflates to 8 MiB: counting declared sizes alone
      // would let it through while it is inflated in full
      const lying = withDeclaredSize(
        withBomb(small, 8 * MB),
        'xl/media/bomb.bin',
        1,
      )
      await expectLimitError(
        new ExcelJS.Workbook().xlsx.load(lying),
        /xl\/media\/bomb\.bin inflates to more than the 1 bytes it declares/,
      )
      // with no size limit the entry is read in full, as before
      await new ExcelJS.Workbook().xlsx.load(lying, {
        maxUncompressedSize: null,
      })
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

    it('applies the limits to xlsx.readFile', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exceljs-limits-'))
      try {
        const filename = path.join(dir, 'bomb.xlsx')
        fs.writeFileSync(filename, withBomb(small, 8 * MB))
        await expectLimitError(
          new ExcelJS.Workbook().xlsx.readFile(filename, {
            maxUncompressedSize: 4 * MB,
          }),
          /maxUncompressedSize/,
        )
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('treats a limit of 0 as rejecting everything', async () => {
      await expectLimitError(
        new ExcelJS.Workbook().xlsx.load(small, { maxEntries: 0 }),
        /more than 0 entries/,
      )
      await expectLimitError(
        new ExcelJS.Workbook().xlsx.load(small, { maxUncompressedSize: 0 }),
        /exceeds 0 bytes/,
      )
      await expectLimitError(
        streamRead(Readable.from([small]), { maxEntries: 0 }),
        /more than 0 entries/,
      )
      await expectLimitError(
        streamRead(Readable.from([small]), { maxUncompressedSize: 0 }),
        /exceeds 0 bytes/,
      )
    })

    it('validates the limit options', async () => {
      const invalid = [-1, NaN, '10']
      const options = ['maxEntries', 'maxUncompressedSize'].flatMap((name) =>
        invalid.map((value) => ({ [name]: value })),
      )
      const errors = await Promise.all(
        options.map((option) =>
          rejectionOf(new ExcelJS.Workbook().xlsx.load(small, option)),
        ),
      )
      errors.forEach((error, i) => {
        const label = JSON.stringify(options[i])
        expect(error, label).to.be.an.instanceOf(TypeError)
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

    it('keeps the constructor limits when read() is given options', async () => {
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([large]),
        { maxUncompressedSize: 64 * 1024 },
      )
      let error
      reader.on('error', (e) => {
        error = e
      })
      reader.on('worksheet', (worksheet) => worksheet.on('row', () => {}))
      await reader.read(undefined, { worksheets: 'emit' })
      expect(error && error.code).to.equal(LIMIT_CODE)
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

    it('counts media too, although it is drained without buffering', async () => {
      await expectLimitError(
        streamRead(Readable.from([withBomb(small, 8 * MB)]), {
          maxUncompressedSize: MB,
        }),
        /maxUncompressedSize/,
      )
      // and within the limit, media doesn't stop the read
      const rows = await streamRead(Readable.from([withBomb(small, 8 * MB)]), {
        maxUncompressedSize: 16 * MB,
      })
      expect(rows).to.equal(1)
    })

    it('reads an archive without xl/workbook.xml', async () => {
      // used to throw a TypeError on the missing workbook model
      await streamRead(path.join(__dirname, 'data', 'missing-bits.xlsx'), {})
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
        if (dir) fs.rmSync(dir, { recursive: true, force: true })
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

    it('rejects a for await consumer on a limit hit in hyperlinks', async () => {
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
      // the sheet rels first, so the limit is crossed while they stream
      const buffer = rezip(
        Buffer.from(await wb.xlsx.writeBuffer()),
        ({ [rels]: relsXml, ...rest }) => {
          relsSize = relsXml.length
          return { [rels]: relsXml, ...rest }
        },
      )
      for (const hyperlinks of ['cache', 'emit']) {
        // eslint-disable-next-line no-await-in-loop
        const error = await rejectionOf(
          streamRead(Readable.from([buffer]), {
            hyperlinks,
            maxUncompressedSize: relsSize - 1,
          }),
        )
        expect(error && error.code, hyperlinks).to.equal(LIMIT_CODE)
      }
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
        await promiseImmediate()
        expect(error, 'expected an error event').to.be.an.instanceOf(Error)
        expect(error.code).to.equal(LIMIT_CODE)
        expect(unhandled).to.have.length(0)
      } finally {
        process.removeListener('unhandledRejection', onUnhandled)
      }
    })

    it('reports malformed hyperlinks XML on the workbook and finishes the read', async () => {
      const wb = new ExcelJS.Workbook()
      wb.addWorksheet('sheet').getCell('A1').value = {
        text: 'link',
        hyperlink: 'https://example.com',
      }
      const buffer = rezip(
        Buffer.from(await wb.xlsx.writeBuffer()),
        (files) => ({
          ...files,
          'xl/worksheets/_rels/sheet1.xml.rels': strToU8(
            '<Relationships><Relationship Id="rId1" <<<broken',
          ),
        }),
      )
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([buffer]),
        { hyperlinks: 'emit' },
      )
      const hyperlinkReads = []
      reader.on('hyperlinks', (hyperlinks) => {
        hyperlinkReads.push(
          hyperlinks.read().then(
            () => undefined,
            (error) => error,
          ),
        )
      })
      reader.on('worksheet', (worksheet) => worksheet.on('row', () => {}))
      // the workbook read must settle, not hang on the abandoned entry
      const workbookError = await new Promise((resolve) => {
        reader.on('end', () => resolve(undefined))
        reader.on('error', resolve)
        reader.read()
      })
      expect(workbookError, 'workbook error').to.be.an.instanceOf(Error)
      expect(workbookError.code).to.not.equal(LIMIT_CODE)
      expect(hyperlinkReads).to.have.length(1)
      expect(await hyperlinkReads[0]).to.equal(workbookError)
    })

    it('lets a hyperlinks listener defer its read()', async () => {
      const wb = new ExcelJS.Workbook()
      const ws = wb.addWorksheet('sheet')
      for (let i = 1; i <= 20; i++) {
        ws.getCell(`A${i}`).value = {
          text: `link ${i}`,
          hyperlink: `https://example.com/${i}`,
        }
      }
      const unhandled = []
      const onUnhandled = (error) => unhandled.push(error)
      process.on('unhandledRejection', onUnhandled)
      try {
        const reader = new ExcelJS.stream.xlsx.WorkbookReader(
          Readable.from([Buffer.from(await wb.xlsx.writeBuffer())]),
          { hyperlinks: 'emit' },
        )
        const pending = []
        reader.on('hyperlinks', (hyperlinks) => pending.push(hyperlinks))
        reader.on('worksheet', (worksheet) => worksheet.on('row', () => {}))
        await new Promise((resolve, reject) => {
          reader.on('end', resolve)
          reader.on('error', reject)
          reader.read()
        })
        // The workbook reader already read them before moving on; a late
        // read() shares that read instead of finding the entry consumed
        expect(pending).to.have.length(1)
        await pending[0].read()
        await promiseImmediate()
        expect(unhandled).to.have.length(0)
      } finally {
        process.removeListener('unhandledRejection', onUnhandled)
      }
    })

    it('rejects an input stream that was already partly read', async () => {
      const input = Readable.from([small.subarray(0, 100), small.subarray(100)])
      input.read()
      const error = await rejectionOf(streamRead(input))
      expect(error, 'expected a rejection').to.be.an.instanceOf(Error)
      expect(error.message).to.match(/already read from or closed/)
    })

    it('reads dates from an archive without xl/workbook.xml', async () => {
      const wb = new ExcelJS.Workbook()
      wb.addWorksheet('sheet').getCell('A1').value = new Date(
        Date.UTC(2021, 0, 1),
      )
      const buffer = rezip(
        Buffer.from(await wb.xlsx.writeBuffer()),
        (files) => {
          const rest = { ...files }
          delete rest['xl/workbook.xml']
          return rest
        },
      )
      // used to throw a TypeError on the missing workbook properties
      const rows = await streamRead(Readable.from([buffer]), {
        styles: 'cache',
      })
      expect(rows).to.equal(1)
    })

    it('fails the read on malformed hyperlinks XML despite an error listener', async () => {
      const wb = new ExcelJS.Workbook()
      wb.addWorksheet('sheet').getCell('A1').value = {
        text: 'link',
        hyperlink: 'https://example.com',
      }
      const buffer = rezip(
        Buffer.from(await wb.xlsx.writeBuffer()),
        (files) => ({
          ...files,
          'xl/worksheets/_rels/sheet1.xml.rels': strToU8(
            '<Relationships><Relationship Id="rId1" <<<broken',
          ),
        }),
      )
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([buffer]),
        { hyperlinks: 'emit' },
      )
      const hyperlinkErrors = []
      reader.on('hyperlinks', (hyperlinks) => {
        hyperlinks.on('error', (error) => hyperlinkErrors.push(error))
        hyperlinks.read()
      })
      reader.on('worksheet', (worksheet) => worksheet.on('row', () => {}))
      const workbookError = await new Promise((resolve) => {
        reader.on('end', () => resolve(undefined))
        reader.on('error', resolve)
        reader.read()
      })
      expect(workbookError, 'workbook error').to.be.an.instanceOf(Error)
      expect(hyperlinkErrors).to.deep.equal([workbookError])
    })

    it('fails the read on malformed worksheet XML despite an error listener', async () => {
      const buffer = rezip(small, (files) => ({
        ...files,
        'xl/worksheets/sheet1.xml': strToU8(
          '<worksheet><sheetData><row r="1" <<<broken',
        ),
      }))
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([buffer]),
      )
      const worksheetErrors = []
      reader.on('worksheet', (worksheet) => {
        worksheet.on('error', (error) => worksheetErrors.push(error))
        worksheet.on('row', () => {})
      })
      const workbookError = await new Promise((resolve) => {
        reader.on('end', () => resolve(undefined))
        reader.on('error', resolve)
        reader.read()
      })
      expect(workbookError, 'workbook error').to.be.an.instanceOf(Error)
      expect(worksheetErrors).to.deep.equal([workbookError])
    })

    it('lets a worksheet listener iterate it during read()', async () => {
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([large]),
      )
      const iterations = []
      reader.on('worksheet', (worksheet) => {
        iterations.push(
          (async () => {
            let rows = 0
            for await (const row of worksheet) {
              if (row) rows++
            }
            return rows
          })(),
        )
      })
      const error = await new Promise((resolve) => {
        reader.on('error', resolve)
        reader.on('end', () => resolve(undefined))
        reader.read()
      })
      expect(error).to.equal(undefined)
      expect(await Promise.all(iterations)).to.deep.equal([5000])
    })

    it('reports a worksheet error to its listener without an unhandled rejection', async () => {
      const buffer = rezip(small, (files) => ({
        ...files,
        'xl/worksheets/sheet1.xml': strToU8(
          '<worksheet><sheetData><row r="1" <<<broken',
        ),
      }))
      const unhandled = []
      const onUnhandled = (error) => unhandled.push(error)
      process.on('unhandledRejection', onUnhandled)
      try {
        const reader = new ExcelJS.stream.xlsx.WorkbookReader(
          Readable.from([buffer]),
        )
        const errors = []
        for await (const { eventType, value } of reader.parse()) {
          if (eventType === 'worksheet') {
            value.on('error', (error) => errors.push(error))
            value.on('row', () => {})
            // not awaited: the listener is what hears about the error
            value.read()
          }
        }
        await promiseImmediate()
        await promiseImmediate()
        expect(errors).to.have.length(1)
        expect(unhandled).to.have.length(0)
      } finally {
        process.removeListener('unhandledRejection', onUnhandled)
      }
    })

    it('reads a worksheet only once', async () => {
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([large]),
      )
      for await (const worksheet of reader) {
        let rows = 0
        worksheet.on('row', () => rows++)
        const first = worksheet.read()
        // a second read() shares the first rather than finding no rows
        expect(worksheet.read()).to.equal(first)
        await first
        expect(rows).to.equal(5000)
        const error = await rejectionOf(
          (async () => {
            for await (const row of worksheet) {
              expect(row).to.be.ok()
            }
          })(),
        )
        expect(error, 'expected iterating again to fail').to.be.an.instanceOf(
          Error,
        )
        expect(error.message).to.match(/already read/)
      }
    })

    it('lets a parse() consumer read hyperlinks after moving on', async () => {
      const wb = new ExcelJS.Workbook()
      const ws = wb.addWorksheet('sheet')
      for (let i = 1; i <= 20; i++) {
        ws.getCell(`A${i}`).value = {
          text: `link ${i}`,
          hyperlink: `https://example.com/${i}`,
        }
      }
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([Buffer.from(await wb.xlsx.writeBuffer())]),
        { hyperlinks: 'emit' },
      )
      const pending = []
      for await (const { eventType, value } of reader.parse()) {
        if (eventType === 'hyperlinks') pending.push(value)
        if (eventType === 'worksheet') {
          // eslint-disable-next-line no-unused-vars
          for await (const rows of value) {
            // drain the rows
          }
        }
      }
      expect(pending).to.have.length(1)
      // parse() already read them before draining the entry
      await pending[0].read()
    })

    it('rejects an input stream that already failed or was closed', async () => {
      const errored = new Readable({ read() {} })
      errored.on('error', () => {})
      errored.destroy(new Error('input failed'))
      const closed = new Readable({ read() {} })
      closed.destroy()
      // let the 'error' and 'close' events fire before the reader sees them
      await promiseImmediate()

      const results = await Promise.all(
        [errored, closed].map((input) =>
          streamRead(input).then(
            () => undefined,
            (error) => error,
          ),
        ),
      )
      expect(results[0], 'errored input').to.be.an.instanceOf(Error)
      expect(results[0].message).to.equal('input failed')
      expect(results[1], 'closed input').to.be.an.instanceOf(Error)
      expect(results[1].message).to.match(/already read from or closed/)
    })

    it('stops reading a caller-supplied stream when the consumer stops early', async function () {
      this.timeout(10000)
      const wb = new ExcelJS.Workbook()
      const ws = wb.addWorksheet('sheet')
      for (let i = 1; i <= 20000; i++) {
        ws.addRow([i, `row ${i % 100}`])
      }
      // Shared strings first, so rows stream while the input is still read
      const first = [
        'xl/_rels/workbook.xml.rels',
        'xl/workbook.xml',
        'xl/sharedStrings.xml',
      ]
      const buffer = rezip(
        Buffer.from(await wb.xlsx.writeBuffer()),
        (files) => {
          const ordered = {}
          first.forEach((name) => {
            ordered[name] = files[name]
          })
          return { ...ordered, ...files }
        },
      )
      // The input holds back everything past the first 32 KiB of the sheet
      // until the consumer has stopped, so the reader can't have read it all
      // by then, however slow the consumer is
      const gate = buffer.indexOf('xl/worksheets/sheet1.xml') + 32 * 1024
      expect(buffer.length).to.be.above(gate + 128 * 1024)
      let offset = 0
      let released = false
      let held
      const input = new Readable({
        read() {
          const push = () =>
            this.push(
              offset < buffer.length
                ? buffer.subarray(offset, (offset += 4096))
                : null,
            )
          if (offset >= gate && !released) {
            held = push
          } else {
            setImmediate(push)
          }
        },
      })
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(input, {})
      for await (const worksheet of reader) {
        for await (const rows of worksheet) {
          expect(rows).to.be.ok()
          break
        }
        break
      }
      expect(input.listenerCount('data')).to.equal(0)
      released = true
      if (held) held()
      // The paused input may still fill its own buffer (highWaterMark, 64 KiB
      // by default), but nothing reads it any more, so it then stays put
      await new Promise((resolve) => setTimeout(resolve, 100))
      const settled = offset
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(offset).to.equal(settled)
      expect(offset).to.be.at.most(gate + 96 * 1024)
      // the input is the caller's to close
      expect(input.destroyed).to.equal(false)
    })
  })
})
