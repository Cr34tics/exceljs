const parseSax = verquire('utils/parse-sax')

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

  async function parseError(xml) {
    try {
      for await (const events of parseSax([Buffer.from(xml)])) {
        expect(events).to.be.an('array')
      }
    } catch (error) {
      return error
    }
    return undefined
  }

  it('rejects a long run of comments or instructions without backtracking', async () => {
    // took exponential time in the comments and instructions before the tail:
    // a short run first, which took about a second (a long one never ends,
    // synchronously, so no timeout could fail it)
    const started = Date.now()
    expect(await parseError(`${'<!---->'.repeat(24)}<!--`)).to.be.an.instanceOf(
      Error,
    )
    expect(Date.now() - started).to.be.below(200)
    for (const xml of [
      `${'<!---->'.repeat(200)}<!--`,
      `${'<?a?>'.repeat(200)}<`,
      `${'<?a?>'.repeat(200)}<!DOCTYPE x>`,
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const error = await parseError(xml)
      expect(error, xml.slice(-12)).to.be.an.instanceOf(Error)
    }
    expect(Date.now() - started).to.be.below(2000)
  })

  it('reads a prolog of comments, instructions and whitespace as empty', async () => {
    for (const xml of [
      '',
      ' \n',
      '﻿<?xml version="1.0"?>',
      '<?xml version="1.0"?><!-- a --><!-- b -->\n<?pi x?>',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await parseError(xml), JSON.stringify(xml)).to.equal(undefined)
    }
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
