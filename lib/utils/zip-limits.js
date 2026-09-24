const { Transform } = require('stream')

// Guards against zip decompression bombs when reading xlsx archives.
// Both limits are opt-in: an undefined limit means "unlimited".

const ERROR_CODE = 'ERR_ZIP_LIMIT_EXCEEDED'

function createLimitError(message) {
  const error = new Error(message)
  error.code = ERROR_CODE
  return error
}

function checkLimit(name, value) {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'number' || !(value >= 0)) {
    throw new TypeError(`${name} must be a non-negative number`)
  }
  return value
}

class ZipLimits {
  constructor(options) {
    const { maxEntries, maxUncompressedSize } = options || {}
    this.maxEntries = checkLimit('maxEntries', maxEntries)
    this.maxUncompressedSize = checkLimit(
      'maxUncompressedSize',
      maxUncompressedSize,
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

module.exports = ZipLimits
