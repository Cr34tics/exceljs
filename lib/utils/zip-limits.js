const { Transform, pipeline } = require('stream')

// Guards against zip decompression bombs when reading xlsx archives.
// An omitted (undefined) limit falls back to the reader's default; null or
// Infinity opts out. Unlimited is stored as Infinity.

const ERROR_CODE = 'ERR_ZIP_LIMIT_EXCEEDED'

const GiB = 1024 * 1024 * 1024

// xlsx.load/read/readFile inflate the whole archive into memory, and peak RSS
// runs at roughly 13x the uncompressed size (~20x for crafted sheet XML), so
// 1 GiB already implies 13-20 GB.
// (A single XML part over 512 MiB can't be read anyway: V8's string limit.)
const BUFFERED_DEFAULTS = Object.freeze({
  maxEntries: 10000,
  maxUncompressedSize: 1 * GiB,
})

// The streaming reader is for workbooks too big to load; one full-height
// 26-column sheet is ~1.15 GB uncompressed, so allow a few of those. Note the
// reader holds a worksheet in memory when it comes before the shared strings
// (as in files written by Excel and exceljs) or shared strings aren't cached,
// so this also caps that memory.
const STREAMING_DEFAULTS = Object.freeze({
  maxEntries: 10000,
  maxUncompressedSize: 4 * GiB,
})

function createLimitError(message) {
  const error = new Error(message)
  error.code = ERROR_CODE
  return error
}

function checkLimit(name, value, defaultValue = Infinity) {
  if (value === undefined) {
    return defaultValue
  }
  if (value === null) {
    return Infinity
  }
  if (typeof value !== 'number' || !(value >= 0)) {
    throw new TypeError(
      `${name} must be a non-negative number, null or Infinity`,
    )
  }
  return value
}

class ZipLimits {
  constructor(options, defaults = {}) {
    const { maxEntries, maxUncompressedSize } = options || {}
    this.maxEntries = checkLimit('maxEntries', maxEntries, defaults.maxEntries)
    this.maxUncompressedSize = checkLimit(
      'maxUncompressedSize',
      maxUncompressedSize,
      defaults.maxUncompressedSize,
    )
    this.entries = 0
    this.uncompressedSize = 0
    this.compressedSize = 0
  }

  addEntry() {
    this.entries += 1
    if (this.entries > this.maxEntries) {
      throw createLimitError(
        `Zip archive has more than ${this.maxEntries} entries (maxEntries)`,
      )
    }
  }

  addBytes(size) {
    this.uncompressedSize += size
    if (this.uncompressedSize > this.maxUncompressedSize) {
      throw createLimitError(
        `Zip archive uncompressed size exceeds ${this.maxUncompressedSize} bytes (maxUncompressedSize)`,
      )
    }
  }

  // For readers that trust the sizes an archive declares: a deflated entry is
  // inflated in full whatever size it declares, so what bounds the work is its
  // compressed data, and entries only share compressed bytes (to have them
  // inflated over and over) in an archive crafted to.
  addCompressedBytes(size, archiveSize) {
    this.compressedSize += size
    if (
      this.maxUncompressedSize !== Infinity &&
      this.compressedSize > archiveSize
    ) {
      throw createLimitError(
        'Zip archive entries overlap: their compressed sizes exceed the archive size (maxUncompressedSize)',
      )
    }
  }

  // Wraps a decompressed entry stream so the bytes flowing through it count
  // towards maxUncompressedSize; the stream errors once the limit is crossed.
  countStream(stream) {
    if (this.maxUncompressedSize === Infinity) {
      return stream
    }
    const counter = new Transform({
      transform: (chunk, encoding, callback) => {
        try {
          this.addBytes(chunk.length)
          callback(null, chunk)
        } catch (error) {
          callback(error)
        }
      },
    })
    // pipeline carries errors and premature closes both ways, and destroys the
    // entry once the limit is crossed so it stops inflating. Its callback
    // swallows the error, which may arrive before the consumer attaches its
    // listeners; consumers see it on the returned stream (they check `errored`)
    return pipeline(stream, counter, () => {})
  }
}

ZipLimits.ERROR_CODE = ERROR_CODE
ZipLimits.BUFFERED_DEFAULTS = BUFFERED_DEFAULTS
ZipLimits.STREAMING_DEFAULTS = STREAMING_DEFAULTS

module.exports = ZipLimits
