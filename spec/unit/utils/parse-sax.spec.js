const parseSax = verquire('utils/parse-sax')
const { rejectionOf } = require('../../utils/tools')

describe('parseSax', () => {
  it('decodes a UTF-8 character split between two chunks', async () => {
    const bytes = Buffer.from('<a>你好</a>')
    // split inside 你, which takes bytes 3 to 5
    const chunks = [bytes.subarray(0, 4), bytes.subarray(4)]
    let text = ''
    for await (const events of parseSax(chunks)) {
      events.forEach(({ eventType, value }) => {
        if (eventType === 'text') text += value
      })
    }
    expect(text).to.equal('你好')
  })

  // The error parsing `xml` (a string, or an array of chunks) fails with
  async function parseError(xml) {
    const chunks = (Array.isArray(xml) ? xml : [xml]).map((c) => Buffer.from(c))
    return rejectionOf(
      (async () => {
        for await (const events of parseSax(chunks)) {
          expect(events).to.be.an('array')
        }
      })(),
    )
  }
  const parseErrors = (xmls) => Promise.all(xmls.map(parseError))

  it('rejects a long run of comments or instructions without backtracking', async () => {
    // took exponential time in the comments and instructions before the tail:
    // a short run first, which took about a second (a long one never ends,
    // synchronously, so no timeout could fail it)
    const started = Date.now()
    expect(await parseError(`${'<!---->'.repeat(24)}<!--`)).to.be.an.instanceOf(
      Error,
    )
    expect(Date.now() - started).to.be.below(200)
    const errors = await parseErrors([
      `${'<!---->'.repeat(200)}<!--`,
      `${'<?a?>'.repeat(200)}<`,
      `${'<?a?>'.repeat(200)}<!DOCTYPE x>`,
    ])
    errors.forEach((error, i) =>
      expect(error, String(i)).to.be.an.instanceOf(Error),
    )
    expect(Date.now() - started).to.be.below(2000)
  })

  it('reads a prolog of comments, instructions and whitespace as empty', async () => {
    const errors = await parseErrors([
      '',
      ' \n',
      '﻿<?xml version="1.0"?>',
      '<?xml version="1.0"?><!-- a --><!-- b -->\n<?pi x?>',
    ])
    expect(errors).to.deep.equal([undefined, undefined, undefined, undefined])
  })

  it('reads a prolog of any size as empty', async () => {
    const errors = await parseErrors([
      ' '.repeat(65 * 1024 + 1),
      `<?xml version="1.0"?><!--${'x'.repeat(100 * 1024)}-->`,
      `${'<!-- c -->'.repeat(10000)}\n`,
    ])
    expect(errors).to.deep.equal([undefined, undefined, undefined])
  })

  it('reads a prolog split between chunks anywhere as empty', async () => {
    const xml = '﻿<?xml version="1.0"?> <!-- a - b --> <?pi x?>\n'
    // one character per chunk splits every item and terminator
    expect(await parseError([...xml])).to.equal(undefined)
    const bad = ['<!-- a ->', '<?pi', '<!-', '<', 'x', '<!--->', '<?>']
    const errors = await parseErrors(
      bad.map((tail) => [...`<?xml version="1.0"?>${tail}`]),
    )
    errors.forEach((error, i) =>
      expect(error, bad[i]).to.be.an.instanceOf(Error),
    )
  })

  it('rejects malformed comments and instructions in a prolog', async () => {
    const errors = await parseErrors(['<?xml version="1.0"?><?>', '<!--->'])
    errors.forEach((error, i) =>
      expect(error, String(i)).to.be.an.instanceOf(Error),
    )
  })

  it('rejects a part with only a DOCTYPE and no element', async () => {
    // (read as empty before the prolog check: not a prolog it accepts)
    expect(
      await parseError('<?xml version="1.0"?><!DOCTYPE x>'),
    ).to.be.an.instanceOf(Error)
  })

  it('rejects an incomplete character after the root element', async () => {
    const error = await parseError([
      Buffer.from('<a>x</a>'),
      Buffer.from([0xe2]),
    ])
    expect(error).to.be.an.instanceOf(Error)
  })

  it('yields the events the end of the input flushes', async () => {
    const types = []
    for await (const events of parseSax([Buffer.from('<a>b</a>\n')])) {
      types.push(...events.map(({ eventType }) => eventType))
    }
    // the trailing text is only reported when the parser closes
    expect(types).to.deep.equal(['opentag', 'text', 'closetag', 'text'])
  })

  it('stops at the first error rather than report every open element', async () => {
    const { SaxesParser } = require('saxes')
    const { makeError } = SaxesParser.prototype
    let errors = 0
    SaxesParser.prototype.makeError = function (...args) {
      errors++
      return makeError.apply(this, args)
    }
    try {
      const error = await parseError(`<a>${'<b>'.repeat(1000)}`)
      expect(error.message).to.match(/unclosed tag/)
    } finally {
      SaxesParser.prototype.makeError = makeError
    }
    expect(errors).to.equal(1)
  })
})
