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

  const contents = []
  const onData = (data) => contents.push(data)
  stream.on('data', onData)

  let resolveStreamEndedPromise
  const streamEndedPromise = new Promise((resolve) => {
    resolveStreamEndedPromise = resolve
  })

  let ended = false
  stream.on('end', () => {
    ended = true
    resolveStreamEndedPromise()
  })

  let error = false
  stream.on('error', (err) => {
    error = err
    resolveStreamEndedPromise()
  })

  try {
    while (!ended || contents.length > 0) {
      if (contents.length === 0) {
        stream.resume()
        // eslint-disable-next-line no-await-in-loop
        await Promise.race([once(stream, 'data'), streamEndedPromise])
      } else {
        stream.pause()
        const data = contents.shift()
        yield data
      }
      if (error) throw error
    }
  } finally {
    // A consumer that stops early (a parser done at its closing tag, a loop
    // that breaks, a parse error) must not leave this listener collecting
    // whatever is later drained from the stream, nor leave the stream paused:
    // someone else may be draining it and would wait forever
    stream.removeListener('data', onData)
    contents.length = 0
    if (!ended && !error) stream.resume()
  }
  resolveStreamEndedPromise()
}

function once(eventEmitter, type) {
  // TODO: Use require('events').once when node v10 is dropped
  return new Promise((resolve) => {
    let fired = false
    const handler = () => {
      if (!fired) {
        fired = true
        eventEmitter.removeListener(type, handler)
        resolve()
      }
    }
    eventEmitter.addListener(type, handler)
  })
}

module.exports = iterateStream
module.exports.checkUnread = checkUnread
