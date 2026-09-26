// A stream that already failed, was closed, ended or was partly read by
// someone else will never deliver all of its data and an 'end' or 'error', so
// reading it would hang or see partial data: throw its error, or `message`
function checkUnread(stream, message) {
  if (stream.errored) throw stream.errored
  if (stream.destroyed || stream.readableEnded || stream.readableDidRead) {
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
module.exports.checkUnread = checkUnread
