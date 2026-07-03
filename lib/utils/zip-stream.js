const events = require('events')
const { zipSync, strToU8 } = require('fflate')

const StreamBuf = require('./stream-buf')

// =============================================================================
// The ZipWriter class
// Packs streamed data into an output zip stream
class ZipWriter extends events.EventEmitter {
  constructor(options) {
    super()
    options = options || {}
    // Map the legacy JSZip generateAsync options onto fflate's numeric deflate level:
    // STORE => no compression (0); DEFLATE => compressionOptions.level (default 6).
    if (options.compression === 'STORE') {
      this.level = 0
    } else {
      const level =
        options.compressionOptions && options.compressionOptions.level
      // fflate expects an integer deflate level in [0, 9]; default to 6 for
      // missing/invalid values and clamp anything out of range.
      this.level = Number.isFinite(level)
        ? Math.min(9, Math.max(0, Math.round(level)))
        : 6
    }

    this.files = {}
    this.stream = new StreamBuf()
  }

  append(data, options) {
    if (options.hasOwnProperty('base64') && options.base64) {
      // base64-encoded content (e.g. media): decode to raw bytes. Buffer is a
      // Uint8Array (in Node and via the browser buffer polyfill), so fflate can
      // consume it directly without an extra copy.
      this.files[options.name] = Buffer.from(data, 'base64')
    } else if (typeof data === 'string') {
      // UTF-8 encode XML / text entries
      this.files[options.name] = strToU8(data)
    } else {
      // Buffer / Uint8Array / ArrayBuffer
      this.files[options.name] =
        data instanceof Uint8Array ? data : new Uint8Array(data)
    }
  }

  finalize() {
    try {
      const zipped = zipSync(this.files, { level: this.level })
      // zipSync returns a Uint8Array we own; wrap it in a zero-copy Buffer view
      // rather than copying the whole archive into a fresh Buffer.
      this.stream.end(
        Buffer.from(zipped.buffer, zipped.byteOffset, zipped.byteLength),
      )
      this.emit('finish')
    } catch (error) {
      this.emit('error', error)
    }
  }

  // ==========================================================================
  // Stream.Readable interface
  read(size) {
    return this.stream.read(size)
  }

  setEncoding(encoding) {
    return this.stream.setEncoding(encoding)
  }

  pause() {
    return this.stream.pause()
  }

  resume() {
    return this.stream.resume()
  }

  isPaused() {
    return this.stream.isPaused()
  }

  pipe(destination, options) {
    return this.stream.pipe(destination, options)
  }

  unpipe(destination) {
    return this.stream.unpipe(destination)
  }

  unshift(chunk) {
    return this.stream.unshift(chunk)
  }

  wrap(stream) {
    return this.stream.wrap(stream)
  }
}

// =============================================================================

module.exports = {
  ZipWriter,
}
