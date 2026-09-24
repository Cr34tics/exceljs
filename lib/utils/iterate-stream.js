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
        const nextData = once(stream, 'data')
        // eslint-disable-next-line no-await-in-loop
        await Promise.race([nextData, streamEndedPromise])
        // the stream may have ended or failed instead: drop the listener
        nextData.cancel()
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
    if (!ended && !error) stream.resume()
  }
  resolveStreamEndedPromise()
}

// Resolves on the next `type` event; cancel() removes the listener when the
// caller stops waiting for another reason
function once(eventEmitter, type) {
  let handler
  const promise = new Promise((resolve) => {
    handler = () => {
      eventEmitter.removeListener(type, handler)
      resolve()
    }
    eventEmitter.addListener(type, handler)
  })
  promise.cancel = () => eventEmitter.removeListener(type, handler)
  return promise
}

module.exports = iterateStream
module.exports.checkUnread = checkUnread
