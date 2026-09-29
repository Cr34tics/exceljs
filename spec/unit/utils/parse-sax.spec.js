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
})
