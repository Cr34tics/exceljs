const { SaxesParser } = require('saxes')
const { PassThrough } = require('stream')
const { createStreamDecoder } = require('./browser-buffer-decode')

// A prolog without any element: each alternative starts with a different
// character, and whitespace is matched one character at a time, so this
// can't backtrack badly
const PROLOG = /^(?:[\s\ufeff]|<\?[^]*?\?>|<!--[^]*?-->)*$/
const MAX_PROLOG = 64 * 1024

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
  // What was written before the first element, kept while short enough to be
  // only the prolog: whitespace, a BOM, the XML declaration, comments
  let prolog = ''
  const write = (text) => {
    if (!sawElement && prolog.length <= MAX_PROLOG) prolog += text
    saxesParser.write(text)
  }
  for await (const chunk of iterable) {
    write(decode(chunk))
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
  if (rest) write(rest)
  // saxes reports XML cut off mid-document (unclosed tags, no root element)
  // only when closed. A part with no element and nothing but a prolog (empty,
  // whitespace, a BOM, the XML declaration, comments) is read as empty, as it
  // always was: xlsx.load() reads files with such a styles.xml or core.xml.
  if (sawElement || !(prolog.length <= MAX_PROLOG && PROLOG.test(prolog))) {
    saxesParser.close()
  }
  if (error) throw error
  if (events.length) yield events
}
