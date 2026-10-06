const fs = require('fs')
const os = require('os')
const path = require('path')
const { PassThrough, Readable } = require('stream')
const { strToU8, unzipSync, zipSync } = require('fflate')
const {
  rezip,
  incompressible,
  withDeclaredSize,
  reorder,
} = require('../utils/zip-fixtures')

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

// Adds a highly compressible entry, as a zip bomb would
function withBomb(buffer, size, name = 'xl/media/bomb.bin') {
  return rezip(buffer, (files) => ({ ...files, [name]: new Uint8Array(size) }))
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

// Puts the parts a worksheet depends on first, so the streaming reader
// streams the worksheet rather than buffering it (Excel and exceljs write
// the worksheet first)
function streamedLayoutFiles(files, last = []) {
  return reorder(files, {
    first: [
      'xl/_rels/workbook.xml.rels',
      'xl/workbook.xml',
      'xl/sharedStrings.xml',
    ].filter((name) => !last.includes(name)),
    last,
  })
}

// Puts a worksheet first, before every part it depends on, as Excel and
// exceljs write it, so the streaming reader buffers it
function sheetFirst(buffer) {
  return rezip(buffer, (files) =>
    reorder(files, { first: ['xl/worksheets/sheet1.xml'] }),
  )
}

const BROKEN_RELS = strToU8('<Relationships><Relationship Id="rId1" <<<broken')
const BROKEN_SHEET = strToU8('<worksheet><sheetData><row r="1" <<<broken')

// A workbook whose sheet has `count` hyperlinked cells
async function hyperlinkWorkbook(count) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('sheet')
  for (let i = 1; i <= count; i++) {
    ws.getCell(`A${i}`).value = {
      text: `link ${i}`,
      hyperlink: `https://example.com/${i}`,
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

// A 50-row workbook laid out to stream, followed by 3000 tiny entries
async function paddedWorkbook() {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('sheet')
  // strings, so the worksheet streams (after the shared strings)
  for (let i = 1; i <= 50; i++) ws.addRow([i, 'row'])
  return rezip(
    streamedLayout(Buffer.from(await wb.xlsx.writeBuffer())),
    (files) => {
      const padded = { ...files }
      for (let i = 0; i < 3000; i++) {
        padded[`xl/media/pad${i}`] = [strToU8('x'), { level: 0 }]
      }
      return padded
    },
  )
}

// An input that hands out `buffer` 4096 bytes at a time, each on its own
// macrotask; `offset` is how far it has got
function pacedInput(buffer) {
  const paced = { offset: 0 }
  paced.input = new Readable({
    read() {
      setImmediate(() =>
        this.push(
          paced.offset < buffer.length
            ? buffer.subarray(paced.offset, (paced.offset += 4096))
            : null,
        ),
      )
    },
  })
  return paced
}

function streamedLayout(buffer) {
  return rezip(buffer, streamedLayoutFiles)
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

// Runs a read() to its end: resolves with its 'error', or undefined on 'end'
function settle(reader) {
  return new Promise((resolve) => {
    reader.on('error', resolve)
    reader.on('end', () => resolve(undefined))
    reader.read()
  })
}

// Runs `fn`, then resolves with the unhandled rejections it caused
async function unhandledRejectionsOf(fn) {
  const unhandled = []
  const onUnhandled = (error) => unhandled.push(error)
  process.on('unhandledRejection', onUnhandled)
  try {
    await fn()
    // let the rejections of promises it dropped be reported
    await promiseImmediate()
    await promiseImmediate()
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
  }
  return unhandled
}

// Retries, as a file a reader closes asynchronously can still be open on
// Windows, which then refuses to remove it
function removeDir(dir) {
  fs.rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  })
}

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exceljs-zip-limits-'))
  try {
    return await fn(dir)
  } finally {
    removeDir(dir)
  }
}

// Fails rather than hangs if `promise` doesn't settle in time
function withinTime(promise, what, ms = 1500) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} never settled`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

// Runs `read` (a streamed read, resolving with its rows), counting the bytes
// zlib inflates meanwhile, for the parts the reader inflates
async function inflatedBytesOf(read) {
  const zlib = require('zlib')
  const { createInflateRaw } = zlib
  let bytes = 0
  // (zlib's exports are getters: replace this one with a property)
  Object.defineProperty(zlib, 'createInflateRaw', {
    configurable: true,
    writable: true,
    value: (...args) => {
      const inflater = createInflateRaw(...args)
      inflater.on('data', (chunk) => {
        bytes += chunk.length
      })
      return inflater
    },
  })
  try {
    const rows = await read()
    return { rows, bytes }
  } finally {
    Object.defineProperty(zlib, 'createInflateRaw', {
      configurable: true,
      writable: true,
      value: createInflateRaw,
    })
  }
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
    it('reads a highly compressible entry under the default limits', async function () {
      this.timeout(10000)
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(withBomb(small, 8 * MB))
      expect(wb.getWorksheet('sheet').getCell('A1').value).to.equal('row 1')
    })

    it('rejects input that is not a zip archive with ERR_INVALID_ZIP', async () => {
      for (const data of [Buffer.from('not a zip file'), Buffer.alloc(0)]) {
        // eslint-disable-next-line no-await-in-loop
        const error = await rejectionOf(new ExcelJS.Workbook().xlsx.load(data))
        expect(error).to.be.an.instanceOf(Error)
        expect(error.code).to.equal('ERR_INVALID_ZIP')
        expect(error.message).to.match(/not a valid zip archive/)
      }
    })

    it('rejects invalid limits before reading the input', async () => {
      let pulled = 0
      const input = new Readable({
        read() {
          pulled++
          this.push(pulled > 200 ? null : Buffer.alloc(MB))
        },
      })
      const error = await rejectionOf(
        new ExcelJS.Workbook().xlsx.read(input, { maxUncompressedSize: '1' }),
      )
      expect(error).to.be.an.instanceOf(TypeError)
      expect(pulled).to.equal(0)
      input.destroy()
      // before even looking for the file
      const fileError = await rejectionOf(
        new ExcelJS.Workbook().xlsx.readFile('no-such-file.xlsx', {
          maxEntries: -1,
        }),
      )
      expect(fileError).to.be.an.instanceOf(TypeError)
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
      expect(error.code).to.equal('ERR_INVALID_ZIP')
      expect(error.message).to.match(/not a valid zip archive/)
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
        expect(error.code).to.equal('ERR_INVALID_ZIP')
        expect(error.message).to.match(/not a valid zip archive/)
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
      expect(error.code).to.equal('ERR_INVALID_ZIP')
      expect(error.message).to.match(/not a valid zip archive/)
    })

    it('ignores a zip64 locator that points at no zip64 end record', async () => {
      // as fflate does: the archive's regular end record is still valid
      const zipped = rezip(small)
      const eocd = zipped.length - 22
      const locators = [0xffffffffffffffffn, BigInt(zipped.length + 1000)].map(
        (offset) => {
          const locator = Buffer.alloc(20)
          locator.writeUInt32LE(0x07064b50, 0)
          locator.writeBigUInt64LE(offset, 8)
          return locator
        },
      )
      await Promise.all(
        locators.map(async (locator) => {
          const stray = Buffer.concat([
            zipped.subarray(0, eocd),
            locator,
            zipped.subarray(eocd),
          ])
          const wb = new ExcelJS.Workbook()
          await wb.xlsx.load(stray)
          expect(wb.getWorksheet('sheet').getCell('A1').value).to.equal('row 1')
        }),
      )
    })

    it('reads an archive with an empty styles.xml or core.xml', async () => {
      // as earlier versions did: a part without any element isn't cut-off XML
      const contents = { empty: '', newline: '\n', bom: '\ufeff' }
      const cases = ['xl/styles.xml', 'docProps/core.xml'].flatMap((part) =>
        Object.entries(contents).map(([name, content]) => ({
          part,
          name,
          content,
        })),
      )
      await Promise.all(
        cases.map(async ({ part, name, content }) => {
          const wb = new ExcelJS.Workbook()
          await wb.xlsx.load(
            rezip(small, (files) => ({ ...files, [part]: strToU8(content) })),
          )
          expect(
            wb.getWorksheet('sheet').getCell('A1').value,
            `${part} ${name}`,
          ).to.equal('row 1')
        }),
      )
    })

    it('reads in full, or counts, a large entry that under-declares its size', async () => {
      // incompressible, so its compressed data is fed to the inflater in
      // several chunks, the output buffer growing past the declared size
      const random = incompressible(300 * 1024)
      const lying = withDeclaredSize(
        rezip(small, (files) => ({ ...files, 'xl/media/r.bin': random })),
        'xl/media/r.bin',
        1000,
      )
      const files = unzipLimited(
        lying,
        new ZipLimits({}, ZipLimits.BUFFERED_DEFAULTS),
      )
      expect(Buffer.from(files['xl/media/r.bin'])).to.deep.equal(
        Buffer.from(random),
      )
      await expectLimitError(
        new ExcelJS.Workbook().xlsx.load(lying, {
          maxUncompressedSize: 200 * 1024,
        }),
        /maxUncompressedSize/,
      )
    })

    it('counts what an entry that under-declares its size inflates to', async () => {
      // Declares 1 byte but inflates to 8 MiB: counting declared sizes alone
      // would let it through while it is inflated in full
      const lying = withDeclaredSize(
        withBomb(small, 8 * MB),
        'xl/media/bomb.bin',
        1,
      )
      await expectLimitError(
        new ExcelJS.Workbook().xlsx.load(lying, {
          maxUncompressedSize: 4 * MB,
        }),
        /maxUncompressedSize/,
      )
      // within the limit, its declared size being wrong doesn't matter
      const files = unzipLimited(
        lying,
        new ZipLimits({}, ZipLimits.BUFFERED_DEFAULTS),
      )
      expect(files['xl/media/bomb.bin'].length).to.equal(8 * MB)
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
      await withTempDir(async (dir) => {
        const filename = path.join(dir, 'bomb.xlsx')
        fs.writeFileSync(filename, withBomb(small, 8 * MB))
        await expectLimitError(
          new ExcelJS.Workbook().xlsx.readFile(filename, {
            maxUncompressedSize: 4 * MB,
          }),
          /maxUncompressedSize/,
        )
      })
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

    it('keeps the limits given to a call to that call only', async () => {
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([large]),
        { maxUncompressedSize: 64 * 1024 },
      )
      // lifted for this call
      for await (const { value } of reader.parse(undefined, {
        worksheets: 'emit',
        sharedStrings: 'cache',
        maxUncompressedSize: null,
      })) {
        if (value && value.read) await value.read()
      }
      // back to the constructor's
      await expectLimitError(
        (async () => {
          for await (const { value } of reader.parse(Readable.from([large]))) {
            if (value && value.read) await value.read()
          }
        })(),
        /maxUncompressedSize/,
      )
    })

    it("keeps the constructor's limits when reader.options is changed in place", async () => {
      const readAll = async (reader, ...args) => {
        for await (const { value } of reader.parse(...args)) {
          if (value && value.read) await value.read()
        }
      }
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([large]),
        { maxUncompressedSize: 64 * 1024 },
      )
      reader.options.maxUncompressedSize = null
      await readAll(reader)
      // these options replace reader.options, lift and all
      await readAll(reader, Readable.from([small]), {
        worksheets: 'emit',
        sharedStrings: 'cache',
      })
      await expectLimitError(
        readAll(reader, Readable.from([large])),
        /maxUncompressedSize/,
      )
    })

    it('reads the shared strings of an archive whose workbook rels hold no element', async () => {
      const wb = new ExcelJS.Workbook()
      wb.addWorksheet('a').addRow([1, 'one'])
      wb.addWorksheet('b').addRow(['two', 2])
      // shared strings after the worksheets, as Excel writes them
      const buffer = rezip(Buffer.from(await wb.xlsx.writeBuffer()), (files) =>
        reorder(
          { ...files, 'xl/_rels/workbook.xml.rels': strToU8('') },
          {
            first: ['xl/workbook.xml', 'xl/_rels/workbook.xml.rels'],
            last: ['xl/sharedStrings.xml'],
          },
        ),
      )
      const values = []
      for await (const worksheet of new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([buffer]),
      )) {
        for await (const row of worksheet) {
          values.push([1, 2].map((col) => row.getCell(col).value))
        }
      }
      expect(values).to.deep.equal([
        [1, 'one'],
        ['two', 2],
      ])
    })

    it('reads an archive whose workbook rels hold no element', async () => {
      for (const rels of ['', '  ', '<?xml version="1.0"?>']) {
        const buffer = streamedLayout(
          rezip(small, (files) => ({
            ...files,
            'xl/_rels/workbook.xml.rels': strToU8(rels),
          })),
        )
        // eslint-disable-next-line no-await-in-loop
        expect(await streamRead(Readable.from([buffer]))).to.equal(1)
        const reader = new ExcelJS.stream.xlsx.WorkbookReader(
          Readable.from([buffer]),
        )
        reader.on('worksheet', (worksheet) => worksheet.on('row', () => {}))
        // eslint-disable-next-line no-await-in-loop
        expect(await settle(reader)).to.equal(undefined)
      }
    })

    it('charges the parts it skips their compressed size', async function () {
      this.timeout(10000)
      const buffer = rezip(small, (files) => ({
        ...files,
        'xl/media/random.bin': incompressible(5 * MB),
      }))
      await expectLimitError(
        streamRead(Readable.from([buffer]), { maxUncompressedSize: MB }),
        /maxUncompressedSize/,
      )
    })

    it('closes a file it opened before reporting a failed worksheet read()', async function () {
      this.timeout(10000)
      const broken = streamedLayout(
        rezip(large, (files) => ({
          ...files,
          'xl/worksheets/sheet1.xml': strToU8(
            Buffer.from(files['xl/worksheets/sheet1.xml'])
              .toString()
              .replace('</sheetData>', '</sheetDatax>'),
          ),
          // so the file is still being read when the worksheet fails
          'xl/media/padding.bin': [incompressible(4 * MB), { level: 0 }],
        })),
      )
      await withTempDir(async (dir) => {
        const filename = path.join(dir, 'broken.xlsx')
        fs.writeFileSync(filename, broken)
        const reader = new ExcelJS.stream.xlsx.WorkbookReader(filename)
        reader.on('worksheet', (worksheet) => worksheet.on('row', () => {}))
        let closed
        const error = await new Promise((resolve) => {
          reader.on('error', (e) => {
            closed = reader.stream.closed
            resolve(e)
          })
          reader.on('end', () => resolve(undefined))
          reader.read()
        })
        expect(error).to.be.an.instanceOf(Error)
        expect(closed).to.equal(true)
      })
    })

    it('leaves the error of a read() it stopped waiting for unhandled', async () => {
      const broken = streamedLayout(
        rezip(large, (files) => ({
          ...files,
          'xl/worksheets/sheet1.xml': strToU8(
            Buffer.from(files['xl/worksheets/sheet1.xml'])
              .toString()
              .replace('</sheetData>', '</sheetDatax>'),
          ),
        })),
      )
      const unhandled = await unhandledRejectionsOf(async () => {
        let onUnhandled
        const reported = new Promise((resolve) => {
          onUnhandled = resolve
          process.once('unhandledRejection', resolve)
        })
        for await (const {
          eventType,
          value,
        } of new ExcelJS.stream.xlsx.WorkbookReader(
          Readable.from([broken]),
        ).parse()) {
          if (eventType === 'worksheet') {
            value.on('row', () => {})
            value.read()
            break
          }
        }
        try {
          await withinTime(reported, 'the unhandled rejection')
        } finally {
          process.removeListener('unhandledRejection', onUnhandled)
        }
      })
      expect(unhandled.length).to.be.above(0)
      expect(unhandled[0].message).to.match(/close tag/)
    })

    it('emits hyperlinks before the worksheets of a workbook without shared strings', async () => {
      const wb = new ExcelJS.Workbook()
      const ws = wb.addWorksheet('sheet')
      ws.getCell('A1').value = {
        text: 'link',
        hyperlink: 'https://example.com/',
      }
      ws.getCell('B1').value = 1
      const linked = Buffer.from(await wb.xlsx.writeBuffer())
      // the workbook parts first, rels listing no shared strings, then the
      // sheet, then its rels
      const buffer = rezip(linked, (files) => {
        const rels = 'xl/_rels/workbook.xml.rels'
        const noStrings = Buffer.from(files[rels])
          .toString()
          .replace(/<Relationship [^>]*sharedStrings[^>]*\/>/, '')
        const rest = { ...files, [rels]: strToU8(noStrings) }
        delete rest['xl/sharedStrings.xml']
        return reorder(rest, {
          first: [rels, 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'],
          last: ['xl/worksheets/_rels/sheet1.xml.rels'],
        })
      })
      const order = []
      for await (const { eventType } of new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([buffer]),
        { hyperlinks: 'emit' },
      ).parse()) {
        if (eventType === 'worksheet' || eventType === 'hyperlinks') {
          order.push(eventType)
        }
      }
      expect(order).to.deep.equal(['hyperlinks', 'worksheet'])
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
      const reordered = sheetFirst(large)
      await expectLimitError(
        streamRead(Readable.from([reordered]), {
          maxUncompressedSize: 64 * 1024,
        }),
        /maxUncompressedSize/,
      )
    })

    it('skips a bomb in a part it does not read, without inflating it', async () => {
      // Styles are ignored by default: drained, not inflated. Its compressed
      // bytes are all that count, well under the limit.
      const bomb = withBomb(small, 8 * MB, 'xl/styles.xml')
      const inflated = await inflatedBytesOf(() =>
        streamRead(Readable.from([bomb]), { maxUncompressedSize: 4 * MB }),
      )
      expect(inflated.rows).to.equal(1)
      expect(inflated.bytes).to.be.below(MB)
    })

    it('reports the parts it skips as entries', async () => {
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([small]),
        {
          entries: 'emit',
          worksheets: 'ignore',
          sharedStrings: 'ignore',
          styles: 'ignore',
        },
      )
      const types = []
      reader.on('entry', ({ type }) => types.push(type))
      expect(await settle(reader)).to.equal(undefined)
      expect(types.sort()).to.deep.equal([
        'shared-strings',
        'styles',
        'workbook',
        'worksheet',
      ])
    })

    it('skips media without inflating it', async () => {
      const bomb = withBomb(small, 8 * MB)
      const inflated = await inflatedBytesOf(() =>
        streamRead(Readable.from([bomb]), { maxUncompressedSize: MB }),
      )
      expect(inflated.rows).to.equal(1)
      expect(inflated.bytes).to.be.below(MB)
    })

    it('reads an archive without xl/workbook.xml', async () => {
      // used to throw a TypeError on the missing workbook model
      expect(
        await streamRead(path.join(__dirname, 'data', 'missing-bits.xlsx'), {}),
      ).to.equal(2)
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
      await withTempDir(async (dir) => {
        const filename = path.join(dir, 'large.xlsx')
        fs.writeFileSync(filename, large)
        await expectLimitError(
          streamRead(filename, { maxUncompressedSize: 64 * 1024 }),
          /maxUncompressedSize/,
        )
      })
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
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exceljs-zip-limits-'))
        filename = path.join(dir, 'streamed.xlsx')
        const ordered = streamedLayoutFiles(
          { ...files, 'xl/worksheets/sheet1.xml': strToU8(sheet) },
          ['xl/worksheets/sheet1.xml'],
        )
        fs.writeFileSync(filename, zipSync(ordered, { level: 0 }))
      })
      after(() => {
        if (dir) removeDir(dir)
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
      const linked = await hyperlinkWorkbook(200)
      const rels = 'xl/worksheets/_rels/sheet1.xml.rels'
      let relsSize
      // the sheet rels first, so the limit is crossed while they stream
      const buffer = rezip(linked, (files) => {
        relsSize = files[rels].length
        return reorder(files, { first: [rels] })
      })
      await expectLimitError(
        streamRead(Readable.from([buffer]), {
          hyperlinks: 'emit',
          maxUncompressedSize: relsSize - 1,
        }),
        /maxUncompressedSize/,
      )
    })

    it('reports a limit hit in hyperlinks without an unhandled rejection', async () => {
      const linked = await hyperlinkWorkbook(200)
      const rels = 'xl/worksheets/_rels/sheet1.xml.rels'
      let relsSize
      // Put the sheet rels first so the limit is crossed while they stream
      const buffer = rezip(linked, (files) => {
        relsSize = files[rels].length
        return reorder(files, { first: [rels] })
      })

      let error
      const unhandled = await unhandledRejectionsOf(async () => {
        const reader = new ExcelJS.stream.xlsx.WorkbookReader(
          Readable.from([buffer]),
          { hyperlinks: 'emit', maxUncompressedSize: relsSize - 1 },
        )
        // README "Readable stream" pattern: no 'error' listener on hyperlinks
        reader.on('hyperlinks', (hyperlinks) => {
          hyperlinks.on('hyperlink', () => {})
          hyperlinks.read()
        })
        error = await settle(reader)
      })
      expect(error, 'expected an error event').to.be.an.instanceOf(Error)
      expect(error.code).to.equal(LIMIT_CODE)
      expect(unhandled).to.have.length(0)
    })

    it('reports malformed hyperlinks XML on the workbook and finishes the read', async () => {
      const linked = await hyperlinkWorkbook(1)
      const buffer = rezip(linked, (files) => ({
        ...files,
        'xl/worksheets/_rels/sheet1.xml.rels': BROKEN_RELS,
      }))
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
      const workbookError = await settle(reader)
      expect(workbookError, 'workbook error').to.be.an.instanceOf(Error)
      expect(workbookError.code).to.not.equal(LIMIT_CODE)
      expect(hyperlinkReads).to.have.length(1)
      expect(await hyperlinkReads[0]).to.equal(workbookError)
    })

    it('lets a hyperlinks listener defer its read()', async () => {
      const linked = await hyperlinkWorkbook(20)
      const buffer = linked
      const unhandled = await unhandledRejectionsOf(async () => {
        const reader = new ExcelJS.stream.xlsx.WorkbookReader(
          Readable.from([buffer]),
          { hyperlinks: 'emit' },
        )
        const pending = []
        let delivered = 0
        reader.on('hyperlinks', (hyperlinks) => {
          // listening here, before the workbook reader reads them
          hyperlinks.on('hyperlink', () => delivered++)
          pending.push(hyperlinks)
        })
        reader.on('worksheet', (worksheet) => worksheet.on('row', () => {}))
        expect(await settle(reader)).to.equal(undefined)
        expect(delivered).to.equal(20)
        // The workbook reader already read them before moving on; a late
        // read() shares that read instead of finding the entry consumed
        expect(pending).to.have.length(1)
        await pending[0].read()
        expect(delivered).to.equal(20)
      })
      expect(unhandled).to.have.length(0)
    })

    it('rejects an input stream that was already partly read', async () => {
      const input = Readable.from([small.subarray(0, 100), small.subarray(100)])
      input.read()
      const error = await rejectionOf(streamRead(input))
      expect(error, 'expected a rejection').to.be.an.instanceOf(Error)
    })

    it('reads an input stream that was peeked and unshifted', async () => {
      const input = Readable.from([small])
      await new Promise((resolve) => {
        input.once('readable', resolve)
      })
      const magic = input.read(4)
      expect(magic.readUInt32LE(0)).to.equal(0x04034b50)
      input.unshift(magic)
      expect(await streamRead(input)).to.equal(1)
    })

    it('reads a legacy stream input', async () => {
      const { Stream } = require('stream')
      const input = new Stream()
      input.readable = true
      setImmediate(() => {
        input.emit('data', small)
        input.emit('end')
      })
      expect(await streamRead(input)).to.equal(1)
    })

    it('keeps the constructor limits when options leave them undefined', async () => {
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([large]),
        { maxUncompressedSize: 64 * 1024 },
      )
      const error = await rejectionOf(
        (async () => {
          for await (const { value } of reader.parse(undefined, {
            worksheets: 'emit',
            sharedStrings: 'cache',
            maxUncompressedSize: undefined,
          })) {
            if (value && value.read) await value.read()
          }
        })(),
      )
      expect(error && error.code).to.equal(LIMIT_CODE)
    })

    it('checks the limits as entries are parsed, not as they are read', async () => {
      // unzipper buffers small entries without waiting for them to be read,
      // so a slow consumer would otherwise let the whole archive inflate
      const buffer = await paddedWorkbook()
      const paced = pacedInput(buffer)
      const { input } = paced
      const error = await rejectionOf(
        (async () => {
          const reader = new ExcelJS.stream.xlsx.WorkbookReader(input, {
            maxEntries: 50,
          })
          for await (const worksheet of reader) {
            for await (const row of worksheet) {
              expect(row).to.be.ok()
              await new Promise((resolve) => setTimeout(resolve, 2))
            }
          }
        })(),
      )
      expect(error && error.code).to.equal(LIMIT_CODE)
      expect(paced.offset).to.be.below(buffer.length / 2)
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
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([buffer]),
        { styles: 'cache' },
      )
      const values = []
      for await (const worksheet of reader) {
        for await (const row of worksheet) values.push(row.getCell(1).value)
      }
      expect(values).to.have.length(1)
      expect(values[0]).to.be.an.instanceOf(Date)
      expect(values[0].getTime()).to.equal(Date.UTC(2021, 0, 1))
    })

    it('fails the read on malformed hyperlinks XML despite an error listener', async () => {
      const linked = await hyperlinkWorkbook(1)
      const buffer = rezip(linked, (files) => ({
        ...files,
        'xl/worksheets/_rels/sheet1.xml.rels': BROKEN_RELS,
      }))
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
      const workbookError = await settle(reader)
      expect(workbookError, 'workbook error').to.be.an.instanceOf(Error)
      expect(hyperlinkErrors).to.deep.equal([workbookError])
    })

    it('fails the read on malformed worksheet XML despite an error listener', async () => {
      const buffer = rezip(small, (files) => ({
        ...files,
        'xl/worksheets/sheet1.xml': BROKEN_SHEET,
      }))
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([buffer]),
      )
      const worksheetErrors = []
      reader.on('worksheet', (worksheet) => {
        worksheet.on('error', (error) => worksheetErrors.push(error))
        worksheet.on('row', () => {})
      })
      const workbookError = await settle(reader)
      expect(workbookError, 'workbook error').to.be.an.instanceOf(Error)
      expect(worksheetErrors).to.deep.equal([workbookError])
    })

    it('reads each worksheet itself in read(): a listener cannot iterate it', async () => {
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([large]),
      )
      let rows = 0
      const attempts = []
      reader.on('worksheet', (worksheet) => {
        worksheet.on('row', () => rows++)
        const iterator = worksheet[Symbol.asyncIterator]()
        attempts.push(
          // iterating it, peeking at it (and dropping the iterator), its
          // parse(), and iterating it after an await
          rejectionOf(
            (async () => {
              // eslint-disable-next-line no-unused-vars
              for await (const row of worksheet) {
                // read the rows
              }
            })(),
          ),
          rejectionOf(iterator.next()),
          rejectionOf(worksheet.parse().next()),
          rejectionOf(
            (async () => {
              await null
              // eslint-disable-next-line no-unused-vars
              for await (const row of worksheet) {
                // read the rows
              }
            })(),
          ),
        )
      })
      // none of them can stall the read
      expect(await withinTime(settle(reader), 'the read')).to.equal(undefined)
      expect(rows).to.equal(5000)
      const errors = await Promise.all(attempts)
      expect(errors).to.have.length(4)
      errors.forEach((error) => {
        expect(error).to.be.an.instanceOf(Error)
        expect(error.message).to.match(/listen for its 'row' events/)
      })
    })

    it('streams a worksheet only after xl/workbook.xml', async () => {
      const wb = new ExcelJS.Workbook()
      // strings, so the worksheet would stream after the shared strings
      wb.addWorksheet('sheet', { state: 'hidden' }).getCell('A1').value = 'a'
      wb.addWorksheet('other').getCell('A1').value = 'b'
      // the worksheet's other parts first, xl/workbook.xml last
      const buffer = rezip(Buffer.from(await wb.xlsx.writeBuffer()), (files) =>
        streamedLayoutFiles(files, ['xl/workbook.xml']),
      )
      const states = []
      for await (const worksheet of new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([buffer]),
      )) {
        states.push(worksheet.state)
        // eslint-disable-next-line no-unused-vars
        for await (const row of worksheet) {
          // read the rows
        }
      }
      expect(states).to.deep.equal(['hidden', 'visible'])
    })

    it('fails parse() on an error in a worksheet read() it did not await', async () => {
      const broken = rezip(small, (files) => ({
        ...files,
        'xl/worksheets/sheet1.xml': BROKEN_SHEET,
      }))
      const unhandled = await unhandledRejectionsOf(async () => {
        // the worksheet buffered (as exceljs writes it) and streamed
        const results = await Promise.all(
          [broken, streamedLayout(broken)].map(async (buffer) => {
            const reader = new ExcelJS.stream.xlsx.WorkbookReader(
              Readable.from([buffer]),
            )
            const errors = []
            const error = await rejectionOf(
              (async () => {
                for await (const { eventType, value } of reader.parse()) {
                  if (eventType === 'worksheet') {
                    value.on('error', (e) => errors.push(e))
                    value.on('row', () => {})
                    // not awaited: parse() waits for it, and fails with it
                    value.read()
                  }
                }
              })(),
            )
            return { error, errors }
          }),
        )
        results.forEach(({ error, errors }) => {
          expect(error, 'parse() error').to.be.an.instanceOf(Error)
          expect(errors).to.deep.equal([error])
        })
      })
      expect(unhandled).to.have.length(0)
    })

    it('finishes a worksheet read() under way when the consumer stops', async () => {
      const buffer = streamedLayout(large)
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([buffer]),
      )
      let rows = 0
      let reading
      for await (const worksheet of reader) {
        worksheet.on('row', () => rows++)
        reading = worksheet.read()
        break
      }
      await reading
      expect(rows).to.equal(5000)
    })

    it('moves on from a worksheet whose iteration the consumer left', async () => {
      const wb = new ExcelJS.Workbook()
      for (const name of ['a', 'b']) {
        const ws = wb.addWorksheet(name)
        for (let i = 1; i <= 2000; i++) ws.addRow([i, `row ${i}`])
      }
      const buffer = streamedLayout(Buffer.from(await wb.xlsx.writeBuffer()))
      const firstRows = []
      for await (const worksheet of new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([buffer]),
      )) {
        // peek at the first row only, never closing the iterator
        const { value } = await worksheet[Symbol.asyncIterator]().next()
        firstRows.push(value.number)
      }
      expect(firstRows).to.deep.equal([1, 1])
    })

    it('reads an archive with bytes after its end record', async () => {
      const padded = Buffer.concat([small, Buffer.alloc(100)])
      expect(await streamRead(Readable.from([padded]))).to.equal(1)
    })

    it('rejects an archive cut off between two entries', async () => {
      // cut right before the worksheet's local header
      const zipped = rezip(small)
      const cut = zipped.indexOf(Buffer.from('xl/worksheets/sheet1.xml')) - 30
      const error = await rejectionOf(
        streamRead(Readable.from([zipped.subarray(0, cut)])),
      )
      expect(error, 'expected a rejection').to.be.an.instanceOf(Error)
      expect(error.message).to.match(/truncated/)
    })

    it('rejects when the input is destroyed partway', async () => {
      const input = new Readable({ read() {} })
      input.push(large.subarray(0, large.length / 2))
      setTimeout(() => input.destroy(), 50)
      const error = await rejectionOf(streamRead(input))
      expect(error, 'expected a rejection').to.be.an.instanceOf(Error)
    })

    it('emits shared strings before the worksheets that use them', async () => {
      // the workbook parts first, then the worksheet, then shared strings
      const buffer = rezip(large, (files) =>
        reorder(files, {
          first: ['xl/_rels/workbook.xml.rels', 'xl/workbook.xml'],
          last: ['xl/sharedStrings.xml'],
        }),
      )
      const strings = []
      let resolved = 0
      let cells = 0
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([buffer]),
        { sharedStrings: 'emit' },
      )
      for await (const item of reader.parse()) {
        if (item.eventType === 'worksheet') {
          for await (const row of item.value) {
            const { value } = row.getCell(1)
            if (value && value.sharedString !== undefined) {
              cells++
              if (strings[value.sharedString] !== undefined) resolved++
            }
          }
        } else if (item.eventType === 'shared-strings') {
          strings[item.value.index] = item.value.text
        }
      }
      expect(cells).to.equal(5000)
      expect(resolved).to.equal(cells)
    })

    it('applies limits given to one read() call', async () => {
      // stricter than the constructor's
      const loose = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([small]),
        { maxEntries: null },
      )
      await expectLimitError(
        (async () => {
          for await (const item of loose.parse(undefined, { maxEntries: 2 })) {
            expect(item).to.be.ok()
          }
        })(),
        /maxEntries/,
      )
      // looser than the constructor's
      const strict = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([small]),
        { maxEntries: 2 },
      )
      for await (const { value } of strict.parse(undefined, {
        worksheets: 'emit',
        sharedStrings: 'cache',
        maxEntries: null,
      })) {
        if (value && value.read) await value.read()
      }
      // invalid
      const error = await rejectionOf(
        (async () => {
          for await (const item of loose.parse(Readable.from([small]), {
            maxEntries: '10',
          })) {
            expect(item).to.be.ok()
          }
        })(),
      )
      expect(error).to.be.an.instanceOf(TypeError)
    })

    it('fails an iteration the reader moved on from, rather than ending it empty', async () => {
      const wb = new ExcelJS.Workbook()
      for (const name of ['a', 'b', 'c']) {
        const ws = wb.addWorksheet(name)
        for (let i = 1; i <= 2000; i++) ws.addRow([i, `row ${i}`])
      }
      const buffer = streamedLayout(Buffer.from(await wb.xlsx.writeBuffer()))
      const jobs = []
      for await (const worksheet of new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([buffer]),
      )) {
        // iterated in the background while the loop moves on
        jobs.push(
          (async () => {
            let rows = 0
            // eslint-disable-next-line no-unused-vars
            for await (const row of worksheet) rows++
            return rows
          })().catch((error) => error),
        )
      }
      const results = await Promise.all(jobs)
      expect(results).to.have.length(3)
      results.forEach((result) => {
        if (result instanceof Error) {
          expect(result.message).to.match(/already consumed/)
        } else {
          expect(result).to.equal(2000)
        }
      })
    })

    it('forgets what it read of a previous archive', async () => {
      const named = async (name) => {
        const wb = new ExcelJS.Workbook()
        wb.addWorksheet(name).getCell('A1').value = name
        return Buffer.from(await wb.xlsx.writeBuffer())
      }
      const first = streamedLayout(await named('first'))
      // the worksheet before everything it depends on
      const second = sheetFirst(await named('second'))
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([first]),
      )
      const names = []
      const readNames = async (input) => {
        for await (const { eventType, value } of reader.parse(input)) {
          if (eventType === 'worksheet') {
            names.push(value.name)
            // eslint-disable-next-line no-unused-vars
            for await (const row of value) {
              // read the rows
            }
          }
        }
      }
      await readNames()
      await readNames(Readable.from([second]))
      expect(names).to.deep.equal(['first', 'second'])
    })

    it('holds the input back while the consumer is behind', async function () {
      // building a 3000-entry archive takes a while on a loaded machine
      this.timeout(10000)
      const buffer = await paddedWorkbook()
      const paced = pacedInput(buffer)
      const { input } = paced
      let readWhileBehind
      for await (const worksheet of new ExcelJS.stream.xlsx.WorkbookReader(
        input,
      )) {
        for await (const row of worksheet) {
          expect(row).to.be.ok()
          await new Promise((resolve) => setTimeout(resolve, 2))
        }
        readWhileBehind = paced.offset
      }
      expect(readWhileBehind).to.be.below(buffer.length / 2)
    })

    it('emits hyperlinks before their worksheet unless shared strings are cached', async () => {
      const linked = await hyperlinkWorkbook(1)
      // the workbook parts first, as Excel writes them, then the sheet
      const buffer = streamedLayout(linked)
      const order = []
      for await (const { eventType } of new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([buffer]),
        { hyperlinks: 'emit', sharedStrings: 'ignore' },
      ).parse()) {
        if (eventType === 'worksheet' || eventType === 'hyperlinks') {
          order.push(eventType)
        }
      }
      expect(order).to.deep.equal(['hyperlinks', 'worksheet'])
    })

    it('accepts null options', async () => {
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([small]),
        null,
      )
      let worksheets = 0
      // eslint-disable-next-line no-unused-vars
      for await (const worksheet of reader) worksheets++
      expect(worksheets).to.equal(1)
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
      const linked = await hyperlinkWorkbook(20)
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([linked]),
        { hyperlinks: 'emit' },
      )
      const pending = []
      let delivered = 0
      for await (const { eventType, value } of reader.parse()) {
        if (eventType === 'hyperlinks') {
          value.on('hyperlink', () => delivered++)
          pending.push(value)
        }
        if (eventType === 'worksheet') {
          // eslint-disable-next-line no-unused-vars
          for await (const rows of value) {
            // drain the rows
          }
        }
      }
      expect(pending).to.have.length(1)
      expect(delivered).to.equal(20)
      // parse() already read them before draining the entry
      await pending[0].read()
    })

    it('ignores the hyperlinks part unless hyperlinks are emitted', async () => {
      // nothing reads them in 'cache' mode, so a malformed part is harmless
      const buffer = rezip(small, (files) => ({
        ...files,
        'xl/worksheets/_rels/sheet1.xml.rels': BROKEN_RELS,
      }))
      expect(
        await streamRead(Readable.from([buffer]), { hyperlinks: 'cache' }),
      ).to.equal(1)
    })

    it('lets a consumer stop early while a part is still being read', async () => {
      const linked = await hyperlinkWorkbook(2000)
      const buffer = streamedLayout(linked)
      const errors = []
      const unhandled = await unhandledRejectionsOf(async () => {
        // a worksheet read() nobody awaits, and no 'error' listener
        for await (const worksheet of new ExcelJS.stream.xlsx.WorkbookReader(
          Readable.from([buffer]),
        )) {
          worksheet.on('row', () => {})
          worksheet.read()
          break
        }
        // a hyperlinks read() nobody awaits, with an 'error' listener
        const reader = new ExcelJS.stream.xlsx.WorkbookReader(
          Readable.from([
            rezip(buffer, (files) =>
              reorder(files, {
                first: ['xl/worksheets/_rels/sheet1.xml.rels'],
              }),
            ),
          ]),
          { hyperlinks: 'emit' },
        )
        for await (const { eventType, value } of reader.parse()) {
          if (eventType === 'hyperlinks') {
            value.on('error', (error) => errors.push(error))
            value.on('hyperlink', () => {})
            value.read()
            break
          }
        }
      })
      expect(unhandled).to.have.length(0)
      expect(errors).to.have.length(0)
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
      expect(results[1].message).to.match(/has failed or closed/)
    })

    it('rejects invalid limits when constructed', () => {
      for (const options of [
        { maxEntries: -1 },
        { maxUncompressedSize: '1' },
      ]) {
        expect(
          () =>
            new ExcelJS.stream.xlsx.WorkbookReader(
              Readable.from([small]),
              options,
            ),
          JSON.stringify(options),
        ).to.throw(TypeError)
      }
    })

    it('waits for xl/styles.xml before streaming a worksheet with styles cached', async () => {
      const date = new Date(Date.UTC(2021, 0, 1))
      const wb = new ExcelJS.Workbook()
      // a string too, so the worksheet has shared strings to wait for
      wb.addWorksheet('sheet').addRow(['a', date])
      const buffer = rezip(Buffer.from(await wb.xlsx.writeBuffer()), (files) =>
        streamedLayoutFiles(files, ['xl/styles.xml']),
      )
      const values = []
      for await (const worksheet of new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([buffer]),
        { styles: 'cache' },
      )) {
        for await (const row of worksheet) values.push(row.getCell(2).value)
      }
      expect(values).to.deep.equal([date])
    })

    it('waits for the workbook rels before streaming a worksheet', async () => {
      const wb = new ExcelJS.Workbook()
      wb.addWorksheet('Report', { state: 'hidden' }).getCell('A1').value = 'a'
      wb.addWorksheet('Other').getCell('A1').value = 'b'
      const buffer = rezip(Buffer.from(await wb.xlsx.writeBuffer()), (files) =>
        streamedLayoutFiles(files, ['xl/_rels/workbook.xml.rels']),
      )
      const sheets = []
      for await (const worksheet of new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([buffer]),
      )) {
        sheets.push([worksheet.name, worksheet.state])
        // eslint-disable-next-line no-unused-vars
        for await (const row of worksheet) {
          // read the rows
        }
      }
      expect(sheets).to.deep.equal([
        ['Report', 'hidden'],
        ['Other', 'visible'],
      ])
    })

    it('streams the worksheets of a workbook with no shared strings', async () => {
      const wb = new ExcelJS.Workbook()
      const ws = wb.addWorksheet('sheet')
      for (let i = 1; i <= 2000; i++) ws.addRow([i, i * 2])
      const random = incompressible(MB)
      // no xl/sharedStrings.xml, and a megabyte after the worksheet
      const buffer = rezip(
        streamedLayout(Buffer.from(await wb.xlsx.writeBuffer())),
        (files) => {
          expect(files['xl/sharedStrings.xml']).to.equal(undefined)
          return { ...files, 'xl/media/after.bin': [random, { level: 0 }] }
        },
      )
      const paced = pacedInput(buffer)
      const { input } = paced
      let readAtFirstRow
      let rows = 0
      for await (const worksheet of new ExcelJS.stream.xlsx.WorkbookReader(
        input,
      )) {
        for await (const row of worksheet) {
          if (readAtFirstRow === undefined) readAtFirstRow = paced.offset
          if (row) rows++
        }
      }
      expect(rows).to.equal(2000)
      // buffered, it would come only once the whole archive was read
      expect(readAtFirstRow).to.be.below(buffer.length - MB / 2)
    })

    it('does not buffer a worksheet it does not emit', async () => {
      const { toArray } = Readable.prototype
      let buffered = 0
      Readable.prototype.toArray = function (...args) {
        buffered++
        return toArray.apply(this, args)
      }
      try {
        // the worksheet before the parts it depends on
        const buffer = sheetFirst(large)
        const count = async (worksheets) => {
          buffered = 0
          let emitted = 0
          for await (const {
            eventType,
          } of new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([buffer]), {
            worksheets,
          }).parse()) {
            if (eventType === 'worksheet') emitted++
          }
          return [emitted, buffered]
        }
        expect(await count('ignore')).to.deep.equal([0, 0])
        expect(await count('emit')).to.deep.equal([1, 1])
      } finally {
        Readable.prototype.toArray = toArray
      }
    })

    it('fails the later read of a worksheet the reader moved on from', async () => {
      const wb = new ExcelJS.Workbook()
      for (const name of ['a', 'b']) {
        wb.addWorksheet(name).addRow([1, name])
      }
      const buffer = streamedLayout(Buffer.from(await wb.xlsx.writeBuffer()))
      const skipped = []
      for await (const worksheet of new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([buffer]),
      )) {
        skipped.push(worksheet)
      }
      expect(skipped).to.have.length(2)
      const [first, second] = skipped
      first.on('row', () => {})
      const readError = await withinTime(rejectionOf(first.read()), 'read()')
      expect(readError, 'read() error').to.be.an.instanceOf(Error)
      expect(readError.message).to.match(/already consumed/)
      const iterateError = await withinTime(
        rejectionOf(
          (async () => {
            // eslint-disable-next-line no-unused-vars
            for await (const row of second) {
              // read the rows
            }
          })(),
        ),
        'iteration',
      )
      expect(iterateError, 'iteration error').to.be.an.instanceOf(Error)
      expect(iterateError.message).to.match(/already consumed/)
    })

    it('cuts off the worksheet under way when the consumer stops', async () => {
      let rest
      const unhandled = await unhandledRejectionsOf(async () => {
        for await (const worksheet of new ExcelJS.stream.xlsx.WorkbookReader(
          Readable.from([streamedLayout(large)]),
        )) {
          const rows = worksheet[Symbol.asyncIterator]()
          expect((await rows.next()).value.number).to.equal(1)
          // stop reading the workbook, keeping the worksheet's iterator
          rest = (async () => {
            // eslint-disable-next-line no-await-in-loop, no-empty
            while (!(await rows.next()).done) {}
          })()
          break
        }
        const error = await withinTime(rejectionOf(rest), 'the iteration')
        expect(error, 'iteration error').to.be.an.instanceOf(Error)
        expect(error.message).to.match(/already consumed/)
      })
      expect(unhandled).to.have.length(0)
    })

    it('rejects a worksheet whose XML is cut off', async () => {
      const buffer = rezip(large, (files) => {
        const xml = Buffer.from(files['xl/worksheets/sheet1.xml']).toString()
        // after the second row
        const cut = xml.indexOf('</row>', xml.indexOf('</row>') + 1) + 6
        return {
          ...files,
          'xl/worksheets/sheet1.xml': strToU8(xml.slice(0, cut)),
        }
      })
      const streamed = await rejectionOf(streamRead(Readable.from([buffer])))
      expect(streamed, 'streamed read').to.be.an.instanceOf(Error)
      expect(streamed.message).to.match(/unclosed tag/)
      const loaded = await rejectionOf(new ExcelJS.Workbook().xlsx.load(buffer))
      expect(loaded, 'load()').to.be.an.instanceOf(Error)
    })

    it('rejects a worksheet cut off inside its root tag, but reads a prolog as empty', async () => {
      const xml = Buffer.from(
        unzipSync(large)['xl/worksheets/sheet1.xml'],
      ).toString()
      const root = xml.indexOf('<worksheet')
      const withSheet = (content) =>
        Readable.from([
          rezip(large, (files) => ({
            ...files,
            'xl/worksheets/sheet1.xml': strToU8(content),
          })),
        ])
      const [cut, prolog] = await Promise.all([
        rejectionOf(streamRead(withSheet(xml.slice(0, root + 20)))),
        // only the declaration and a comment: read as empty, as earlier
        // versions did
        streamRead(withSheet(`${xml.slice(0, root)}<!-- nothing -->`)),
      ])
      expect(cut, 'cut off').to.be.an.instanceOf(Error)
      expect(cut.message).to.match(/unclosed tag|unexpected end/)
      expect(prolog, 'prolog').to.equal(0)
    })

    it('loads an archive whose core.xml or rels hold only a declaration', async () => {
      const declaration =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      await Promise.all(
        ['docProps/core.xml', '_rels/.rels'].map(async (part) => {
          const wb = new ExcelJS.Workbook()
          await wb.xlsx.load(
            rezip(small, (files) => ({
              ...files,
              [part]: strToU8(declaration),
            })),
          )
          expect(wb.getWorksheet('sheet').getCell('A1').value, part).to.equal(
            'row 1',
          )
        }),
      )
    })

    it('waits for shared strings whose relationship has another type URI', async () => {
      const wb = new ExcelJS.Workbook()
      wb.addWorksheet('sheet').addRow(['alpha', 'beta', 1])
      // Strict OOXML's type URI, and the order Excel writes the parts in
      const buffer = rezip(
        Buffer.from(await wb.xlsx.writeBuffer()),
        (files) => {
          const rels = 'xl/_rels/workbook.xml.rels'
          const strictRels = Buffer.from(files[rels])
            .toString()
            .replace(
              'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings',
              'http://purl.oclc.org/ooxml/officeDocument/relationships/sharedStrings',
            )
          return reorder(
            { ...files, [rels]: strToU8(strictRels) },
            {
              first: [
                'xl/workbook.xml',
                rels,
                'xl/worksheets/sheet1.xml',
                'xl/sharedStrings.xml',
              ],
            },
          )
        },
      )
      const values = []
      for await (const worksheet of new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([buffer]),
      )) {
        for await (const row of worksheet) {
          values.push([1, 2, 3].map((col) => row.getCell(col).value))
        }
      }
      expect(values).to.deep.equal([['alpha', 'beta', 1]])
    })

    it('applies the streaming defaults, or no limits with null or Infinity', async () => {
      const limitsOf = async (options) => {
        const reader = new ExcelJS.stream.xlsx.WorkbookReader(
          Readable.from([large]),
          options,
        )
        let rows = 0
        for await (const worksheet of reader) {
          // eslint-disable-next-line no-unused-vars
          for await (const row of worksheet) rows++
        }
        expect(rows).to.equal(5000)
        const { maxEntries, maxUncompressedSize } = reader._zipLimits
        return [maxEntries, maxUncompressedSize]
      }
      const results = await Promise.all([
        limitsOf({}),
        limitsOf({ maxEntries: null, maxUncompressedSize: null }),
        limitsOf({ maxEntries: Infinity, maxUncompressedSize: Infinity }),
      ])
      expect(results).to.deep.equal([
        [10000, 4 * 1024 * MB],
        [Infinity, Infinity],
        [Infinity, Infinity],
      ])
    })

    it('keeps the reader options when a call gives only limits', async () => {
      const parsed = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([small]),
      )
      let parsedRows = 0
      for await (const { eventType, value } of parsed.parse(undefined, {
        maxUncompressedSize: 1e9,
      })) {
        if (eventType === 'worksheet') {
          // eslint-disable-next-line no-unused-vars
          for await (const row of value) parsedRows++
        }
      }
      expect(parsedRows).to.equal(1)
      const read = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([small]),
      )
      let readRows = 0
      read.on('worksheet', (worksheet) => worksheet.on('row', () => readRows++))
      const error = await new Promise((resolve) => {
        read.on('error', resolve)
        read.on('end', () => resolve(undefined))
        read.read(undefined, { maxEntries: 50 })
      })
      expect(error).to.equal(undefined)
      expect(readRows).to.equal(1)
    })

    it('applies limits assigned to reader.options', async () => {
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([large]),
      )
      reader.options = {
        worksheets: 'emit',
        sharedStrings: 'cache',
        maxUncompressedSize: 64 * 1024,
      }
      const error = await rejectionOf(
        (async () => {
          for await (const worksheet of reader) {
            // eslint-disable-next-line no-unused-vars
            for await (const row of worksheet) {
              // read the rows
            }
          }
        })(),
      )
      expect(error && error.code).to.equal(LIMIT_CODE)
    })

    it('replaces the reader options with empty ones, and ignores prototype keys', async () => {
      // {} sets no limits, so replaces the options as before: nothing emitted
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([small]),
      )
      const events = []
      for await (const { eventType } of reader.parse(undefined, {})) {
        events.push(eventType)
      }
      expect(events).to.deep.equal([])
      // options parsed from JSON can't reach Object.prototype
      const hostile = JSON.parse('{"__proto__": {"polluted": "yes"}}')
      const polluting = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([small]),
        hostile,
      )
      for await (const item of polluting.parse(undefined, hostile)) {
        expect(item).to.be.ok()
      }
      expect({}.polluted).to.equal(undefined)
    })

    it('reads with options assigned to reader.options', async () => {
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([small]),
      )
      reader.options = { worksheets: 'emit', sharedStrings: 'ignore' }
      const values = []
      for await (const worksheet of reader) {
        for await (const row of worksheet) values.push(row.getCell(1).value)
      }
      expect(values).to.deep.equal([{ sharedString: 0 }])
    })

    it('reads an object-mode input that pushes empty chunks', async () => {
      const empty = Buffer.alloc(0)
      const inputs = [
        [empty, small],
        [small.subarray(0, 100), empty, small.subarray(100)],
        [small, empty],
        [small.subarray(0, 100), '', small.subarray(100)],
      ]
      const rows = await Promise.all(
        inputs.map((chunks) =>
          withinTime(streamRead(Readable.from(chunks)), 'the read'),
        ),
      )
      expect(rows).to.deep.equal([1, 1, 1, 1])
    })

    it('holds back an input that also feeds another stream, losing nothing', async function () {
      this.timeout(10000)
      // a slow worksheet, then 3000 tiny entries queued up behind it
      const buffer = await paddedWorkbook()
      const { input } = pacedInput(buffer)
      // a second consumer of the same input
      const copy = new PassThrough()
      let copied = 0
      copy.on('data', (chunk) => {
        copied += chunk.length
      })
      input.pipe(copy)
      let rows = 0
      for await (const worksheet of new ExcelJS.stream.xlsx.WorkbookReader(
        input,
      )) {
        for await (const row of worksheet) {
          expect(row).to.be.ok()
          rows++
          await new Promise((resolve) => setTimeout(resolve, 2))
        }
      }
      expect(rows).to.equal(50)
      await promiseImmediate()
      expect(copied).to.equal(buffer.length)
    })

    it('reports the hyperlinks parts as entries', async () => {
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([await hyperlinkWorkbook(2)]),
        { entries: 'emit', hyperlinks: 'emit' },
      )
      const types = []
      reader.on('entry', ({ type }) => types.push(type))
      reader.on('hyperlinks', (hyperlinks) =>
        hyperlinks.on('hyperlink', () => {}),
      )
      expect(await settle(reader)).to.equal(undefined)
      expect(types).to.include('hyperlinks')
    })

    it('marks an un-awaited read() reported to an error listener as handled', async () => {
      const broken = streamedLayout(
        rezip(small, (files) => ({
          ...files,
          'xl/worksheets/sheet1.xml': BROKEN_SHEET,
        })),
      )
      let error
      const unhandled = await unhandledRejectionsOf(async () => {
        error = await rejectionOf(
          (async () => {
            for await (const {
              eventType,
              value,
            } of new ExcelJS.stream.xlsx.WorkbookReader(
              Readable.from([broken]),
            ).parse()) {
              if (eventType === 'worksheet') {
                const failed = new Promise((resolve) => {
                  value.on('error', resolve)
                })
                value.on('row', () => {})
                value.read()
                // the read fails while nothing awaits it yet: wait until it
                // has, then long enough for an unhandled rejection to show
                await failed
                // eslint-disable-next-line no-await-in-loop
                for (let i = 0; i < 5; i++) await promiseImmediate()
              }
            }
          })(),
        )
      })
      expect(error, 'parse() error').to.be.an.instanceOf(Error)
      expect(unhandled).to.have.length(0)
    })

    it('streams worksheets with styles cached when the rels list no styles', async () => {
      const wb = new ExcelJS.Workbook()
      const ws = wb.addWorksheet('sheet')
      for (let i = 1; i <= 2000; i++) ws.addRow([i, i * 2])
      const buffer = rezip(
        streamedLayout(Buffer.from(await wb.xlsx.writeBuffer())),
        (files) => {
          const rels = Buffer.from(files['xl/_rels/workbook.xml.rels'])
            .toString()
            .replace(/<Relationship [^>]*styles[^>]*\/>/, '')
          const rest = { ...files }
          delete rest['xl/styles.xml']
          return {
            ...rest,
            'xl/_rels/workbook.xml.rels': strToU8(rels),
            'xl/media/after.bin': [incompressible(MB), { level: 0 }],
          }
        },
      )
      const paced = pacedInput(buffer)
      let readAtFirstRow
      let rows = 0
      for await (const worksheet of new ExcelJS.stream.xlsx.WorkbookReader(
        paced.input,
        { styles: 'cache' },
      )) {
        for await (const row of worksheet) {
          if (readAtFirstRow === undefined) readAtFirstRow = paced.offset
          if (row) rows++
        }
      }
      expect(rows).to.equal(2000)
      // buffered, it would come only once the whole archive was read
      expect(readAtFirstRow).to.be.below(buffer.length - MB / 2)
    })

    it('reads an archive whose xl/workbook.xml has no workbook element', async () => {
      // e.g. a namespace-prefixed root, which the workbook xform doesn't know
      const buffer = rezip(streamedLayout(small), (files) => ({
        ...files,
        'xl/workbook.xml': strToU8(
          '<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
        ),
      }))
      expect(await streamRead(Readable.from([buffer]))).to.equal(1)
    })

    it("emits each shared string as a 'shared-strings' event", async () => {
      const options = { sharedStrings: 'emit' }
      const parsed = []
      for await (const {
        eventType,
        value,
      } of new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([small]),
        options,
      ).parse()) {
        if (eventType === 'shared-strings') parsed.push(value)
      }
      expect(parsed).to.deep.equal([{ index: 0, text: 'row 1' }])
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(
        Readable.from([small]),
        options,
      )
      const emitted = []
      reader.on('shared-strings', (value) => emitted.push(value))
      expect(await settle(reader)).to.equal(undefined)
      expect(emitted).to.deep.equal(parsed)
    })

    it('stops reading a caller-supplied stream when the consumer stops early', async function () {
      this.timeout(10000)
      const wb = new ExcelJS.Workbook()
      const ws = wb.addWorksheet('sheet')
      for (let i = 1; i <= 20000; i++) {
        ws.addRow([i, `row ${i % 100}`])
      }
      // Shared strings first, so rows stream while the input is still read
      const buffer = streamedLayout(Buffer.from(await wb.xlsx.writeBuffer()))
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
      await withinTime(
        (async () => {
          while (input.readableLength < input.readableHighWaterMark) {
            // eslint-disable-next-line no-await-in-loop
            await promiseImmediate()
          }
        })(),
        'the paused input filling its buffer',
        5000,
      )
      // a push already scheduled may still land
      await promiseImmediate()
      const settled = offset
      // eslint-disable-next-line no-await-in-loop
      for (let i = 0; i < 10; i++) await promiseImmediate()
      expect(offset).to.equal(settled)
      expect(offset).to.be.at.most(gate + 96 * 1024)
      // the input is the caller's to close
      expect(input.destroyed).to.equal(false)
    })
  })
})
