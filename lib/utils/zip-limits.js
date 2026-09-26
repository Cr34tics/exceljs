const { Transform, pipeline } = require('stream')

// Guards against zip decompression bombs when reading xlsx archives.
// An omitted (undefined) limit falls back to the reader's default; null or
// Infinity opts out. Unlimited is stored as Infinity.

const ERROR_CODE = 'ERR_ZIP_LIMIT_EXCEEDED'

const GiB = 1024 * 1024 * 1024

// Real workbooks have tens of entries; both readers share this default
const DEFAULT_MAX_ENTRIES = 10000

// xlsx.load/read/readFile inflate the whole archive into memory, and peak RSS
// runs at roughly 13x the uncompressed size (~20x for crafted sheet XML), so
// 1 GiB already implies 13-20 GB.
// (A single XML part over 512 MiB can't be read anyway: V8's string limit.)
const BUFFERED_DEFAULTS = Object.freeze({
  maxEntries: DEFAULT_MAX_ENTRIES,
  maxUncompressedSize: 1 * GiB,
})

// The streaming reader is for workbooks too big to load; one full-height
// 26-column sheet is ~1.15 GB uncompressed, so allow a few of those. Note the
// reader holds a worksheet in memory when it comes before the shared strings
// (as in files written by Excel and exceljs) or shared strings aren't cached,
// so this also caps that memory.
const STREAMING_DEFAULTS = Object.freeze({
  maxEntries: DEFAULT_MAX_ENTRIES,
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
  }

  addEntry() {
    this.entries += 1
    this.checkEntryCount(this.entries)
  }

  // Also for an archive's own entry count, checked before walking its entries
  checkEntryCount(count) {
    if (count > this.maxEntries) {
      throw createLimitError(
        `Zip archive has more than ${this.maxEntries} entries (maxEntries)`,
      )
    }
  }

  addBytes(size) {
    // a NaN would make every later comparison false and disable the limit.
    // Unlike the limit options (checkLimit), a size must also be an exact
    // integer: sizes are added up.
    if (!(size >= 0 && size <= Number.MAX_SAFE_INTEGER)) {
      throw new TypeError(`Invalid zip entry size: ${size}`)
    }
    this.uncompressedSize += size
    if (this.uncompressedSize > this.maxUncompressedSize) {
      throw createLimitError(
        `Zip archive uncompressed size exceeds ${this.maxUncompressedSize} bytes (maxUncompressedSize)`,
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
ZipLimits.createLimitError = createLimitError
ZipLimits.BUFFERED_DEFAULTS = BUFFERED_DEFAULTS
ZipLimits.STREAMING_DEFAULTS = STREAMING_DEFAULTS

module.exports = ZipLimits
