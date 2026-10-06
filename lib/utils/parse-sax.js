const { SaxesParser } = require('saxes')
const { PassThrough } = require('stream')
const { createStreamDecoder } = require('./browser-buffer-decode')

// A prolog without any element: whitespace (\s includes a BOM), processing
// instructions (the XML declaration) and comments. Each comment or
// instruction ends at its first terminator, so there is one way to match a
// prolog and a failing match can't backtrack exponentially (a lazy [^]*?
// could run on past a terminator, into the next comment).
const PROLOG = /^(?:\s|<\?(?:(?!\?>)[^])*\?>|<!--(?:(?!-->)[^])*-->)*$/
const MAX_PROLOG = 64 * 1024

module.exports = async function* (iterable) {
  // TODO: Remove once node v8 is deprecated
  // Detect and upgrade old streams
  if (iterable.pipe && !iterable[Symbol.asyncIterator]) {
    iterable = iterable.pipe(new PassThrough())
  }
  const saxesParser = new SaxesParser()
  // Stop at the first error, thrown out of write() or close(): saxes would
  // otherwise go on, and close() reports every element still open, each as
  // an Error of its own
  saxesParser.on('error', (error) => {
    throw error
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
  if (events.length) yield events
}
