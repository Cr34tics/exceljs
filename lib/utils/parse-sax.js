const { SaxesParser } = require('saxes')
const { PassThrough } = require('stream')
const { createStreamDecoder } = require('./browser-buffer-decode')

// Tells, chunk by chunk, whether text is only a prolog without any element:
// whitespace (\s includes a BOM), processing instructions (the XML
// declaration) and comments. It scans each character once, keeping no more
// than a terminator's worth of text between chunks, so a prolog of any size
// costs linear time and constant memory.
function createPrologScanner() {
  // 'between' items, inside a '<?' instruction or a '<!--' comment, or
  // 'other' once the text can't be a prolog
  let mode = 'between'
  // the start of an item or terminator a chunk ended in
  let carry = ''
  const ENDS = { instruction: '?>', comment: '-->' }
  return {
    write(text) {
      const s = carry + text
      carry = ''
      let i = 0
      while (i < s.length && mode !== 'other') {
        if (mode === 'between') {
          if (/\s/.test(s[i])) {
            i += 1
          } else if (s.startsWith('<?', i)) {
            mode = 'instruction'
            i += 2
          } else if (s.startsWith('<!--', i)) {
            mode = 'comment'
            i += 4
          } else if (s.length - i < 4 && '<!--'.startsWith(s.slice(i))) {
            // '<', '<!' or '<!-' at the end: the next chunk decides
            carry = s.slice(i)
            return
          } else {
            mode = 'other'
          }
        } else {
          const end = ENDS[mode]
          const found = s.indexOf(end, i)
          if (found < 0) {
            // keep what could be the start of the terminator
            carry = s.slice(Math.max(i, s.length - end.length + 1))
            return
          }
          i = found + end.length
          mode = 'between'
        }
      }
    },
    isProlog() {
      return mode === 'between' && carry === ''
    },
  }
}

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
  // whether what was written before the first element is only a prolog
  const prolog = createPrologScanner()
  const write = (text) => {
    if (!sawElement) prolog.write(text)
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
  if (sawElement || !prolog.isProlog()) {
    saxesParser.close()
  }
  if (events.length) yield events
}
