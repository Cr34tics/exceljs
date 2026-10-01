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

// Returns a decode(chunk) for one stream of chunks, and decode() to flush it
// at its end: a UTF-8 character split between two chunks would otherwise
// decode as two replacement characters. Chunks that start and end on a whole
// character, as almost all do, are decoded in one go, which is several times
// faster than streaming mode.
function createStreamDecoder() {
  if (!textDecoder) {
    return (chunk) => (chunk === undefined ? '' : bufferToString(chunk))
  }
  const decoder = new TextDecoder('utf-8')
  // whether the last chunk may have ended inside a character
  let pending = false
  return (chunk) => {
    if (chunk === undefined) {
      return pending ? decoder.decode() : ''
    }
    if (typeof chunk === 'string') {
      return chunk
    }
    const last = chunk.length ? chunk[chunk.length - 1] : 0
    if (!pending && last < 0x80) {
      return decoder.decode(chunk)
    }
    pending = last >= 0x80
    return decoder.decode(chunk, { stream: true })
  }
}

exports.bufferToString = bufferToString
exports.createStreamDecoder = createStreamDecoder
