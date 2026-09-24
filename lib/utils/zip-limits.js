const { Transform } = require('stream')

// Guards against zip decompression bombs when reading xlsx archives.
// An omitted (undefined) limit falls back to the reader's default; null or
// Infinity opts out and means "unlimited".

const ERROR_CODE = 'ERR_ZIP_LIMIT_EXCEEDED'

const GiB = 1024 * 1024 * 1024

// xlsx.load/read/readFile inflate the whole archive into memory, and peak RSS
// runs at roughly 13x the uncompressed size, so 1 GiB already implies ~13 GB.
// (A single XML part over 512 MiB can't be read anyway: V8's string limit.)
const BUFFERED_DEFAULTS = Object.freeze({
  maxEntries: 10000,
  maxUncompressedSize: 1 * GiB,
})

// The streaming reader is for workbooks too big to load; one full-height
// 26-column sheet is ~1.15 GB uncompressed, so allow a few of those.
const STREAMING_DEFAULTS = Object.freeze({
  maxEntries: 10000,
  maxUncompressedSize: 4 * GiB,
})

function createLimitError(message) {
  const error = new Error(message)
  error.code = ERROR_CODE
  return error
}

function checkLimit(name, value, defaultValue) {
  if (value === undefined) {
    return defaultValue
  }
  if (value === null || value === Infinity) {
    return undefined
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

  get enabled() {
    return (
      this.maxEntries !== undefined || this.maxUncompressedSize !== undefined
    )
  }

  addEntry() {
    this.entries += 1
    if (this.maxEntries !== undefined && this.entries > this.maxEntries) {
      throw createLimitError(
        `Zip archive has more than ${this.maxEntries} entries (maxEntries)`,
      )
    }
  }

  addBytes(size) {
    this.uncompressedSize += size
    if (
      this.maxUncompressedSize !== undefined &&
      this.uncompressedSize > this.maxUncompressedSize
    ) {
      throw createLimitError(
        `Zip archive uncompressed size exceeds ${this.maxUncompressedSize} bytes (maxUncompressedSize)`,
      )
    }
  }

  // Wraps a decompressed entry stream so the bytes flowing through it count
  // towards maxUncompressedSize; the stream errors once the limit is crossed.
  countStream(stream) {
    if (this.maxUncompressedSize === undefined) {
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
    stream.on('error', (error) => counter.destroy(error))
    // The pipe can run ahead of the consumer attaching its listeners; keep an
    // early limit error from crashing the process. Consumers check `errored`.
    counter.on('error', () => {})
    return stream.pipe(counter)
  }
}

ZipLimits.ERROR_CODE = ERROR_CODE
ZipLimits.BUFFERED_DEFAULTS = BUFFERED_DEFAULTS
ZipLimits.STREAMING_DEFAULTS = STREAMING_DEFAULTS

module.exports = ZipLimits
