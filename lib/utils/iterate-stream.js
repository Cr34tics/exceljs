// A stream that already failed, was closed or ended will never deliver an
// 'end' or 'error', so reading it would hang: throw its error, or `message`
function checkOpen(stream, message) {
  if (stream.errored) throw stream.errored
  if (stream.destroyed || stream.readableEnded) {
    throw new Error(message)
  }
}

// Also rejects a stream that was partly read, and would give partial data.
// (Not for a caller's input stream: one that was peeked and unshift()ed
// reads as partly read too.)
function checkUnread(stream, message) {
  checkOpen(stream, message)
  if (stream.readableDidRead) {
    throw new Error(message)
  }
}

async function* iterateStream(stream) {
  checkUnread(
    stream,
    'Stream was already consumed: read each streamed worksheet before the workbook reader moves on',
  )
  // A consumer that stops early (a parser done at its closing tag, a loop that
  // breaks, a parse error) leaves the stream open for the workbook reader to
  // drain rather than destroying it. The iterator removes its listeners when
  // it's done, however it's done.
  yield* stream.iterator({ destroyOnReturn: false })
}

module.exports = iterateStream
module.exports.checkOpen = checkOpen
module.exports.checkUnread = checkUnread
