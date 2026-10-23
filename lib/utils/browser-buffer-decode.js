const textDecoder =
  typeof TextDecoder === 'undefined' ? null : new TextDecoder('utf-8')

function bufferToString(chunk) {
  if (typeof chunk === 'string') {
    return chunk
  }
  if (textDecoder) {
    return textDecoder.decode(chunk)
  }
  return chunk.toString()
}

// Any BufferSource (a Uint8Array, another view such as a DataView, or an
// ArrayBuffer), as a byte view
function asBytes(chunk) {
  if (chunk instanceof Uint8Array) return chunk
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  }
  return new Uint8Array(chunk)
}

// Returns a decode(chunk) for one stream of chunks, and decode() to flush it
// at its end: a UTF-8 character split between two chunks would otherwise
// decode as two replacement characters. Chunks that start and end on a whole
// character, as almost all do, are decoded in one go, which is several times
// faster than streaming mode.
function createStreamDecoder() {
  if (!textDecoder) {
    return (chunk) => (chunk === undefined ? '' : bufferToString(chunk))
  }
  // A BOM is dropped only at the very start: decoding chunk by chunk would
  // otherwise also drop a U+FEFF at the start of a later chunk
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  let started = false
  const start = (text) => {
    if (started || !text) return text
    started = true
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  }
  // whether the last chunk may have ended inside a character
  let pending = false
  return (chunk) => {
    if (chunk === undefined) {
      return pending ? start(decoder.decode()) : ''
    }
    if (typeof chunk === 'string') {
      return start(chunk)
    }
    const bytes = asBytes(chunk)
    // an empty chunk changes nothing, a character pending included
    if (!bytes.length) return ''
    const last = bytes[bytes.length - 1]
    if (!pending && last < 0x80) {
      return start(decoder.decode(bytes))
    }
    pending = last >= 0x80
    return start(decoder.decode(bytes, { stream: true }))
  }
}

exports.bufferToString = bufferToString
exports.createStreamDecoder = createStreamDecoder
