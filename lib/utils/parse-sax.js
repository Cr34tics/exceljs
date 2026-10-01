const { SaxesParser } = require('saxes')
const { PassThrough } = require('stream')
const { createStreamDecoder } = require('./browser-buffer-decode')

module.exports = async function* (iterable) {
  // TODO: Remove once node v8 is deprecated
  // Detect and upgrade old streams
  if (iterable.pipe && !iterable[Symbol.asyncIterator]) {
    iterable = iterable.pipe(new PassThrough())
  }
  const saxesParser = new SaxesParser()
  let error
  saxesParser.on('error', (err) => {
    error = err
  })
  let events = []
  let sawElement = false
  saxesParser.on('opentag', (value) => {
    sawElement = true
    events.push({ eventType: 'opentag', value })
  })
  saxesParser.on('text', (value) => events.push({ eventType: 'text', value }))
  saxesParser.on('closetag', (value) =>
    events.push({ eventType: 'closetag', value }),
  )
  const decode = createStreamDecoder()
  for await (const chunk of iterable) {
    saxesParser.write(decode(chunk))
    // saxesParser.write and saxesParser.on() are synchronous,
    // so we can only reach the below line once all events have been emitted
    if (error) throw error
    // As a performance optimization, we gather all events instead of passing
    // them one by one, which would cause each event to go through the event queue
    yield events
    events = []
  }
  // whatever an incomplete character at the very end left in the decoder
  const rest = decode()
  if (rest) saxesParser.write(rest)
  // saxes reports XML cut off mid-document (unclosed tags, no root element)
  // only when closed. A part without any element (empty, or only whitespace
  // or a BOM) is read as empty, as it always was: xlsx.load() reads files
  // with such a styles.xml or core.xml.
  if (sawElement) saxesParser.close()
  if (error) throw error
  if (events.length) yield events
}
