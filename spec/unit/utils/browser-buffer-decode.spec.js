const { createStreamDecoder } = verquire('utils/browser-buffer-decode')

function decodeAll(chunks) {
  const decode = createStreamDecoder()
  return chunks.map((chunk) => decode(chunk)).join('') + decode()
}

describe('createStreamDecoder', () => {
  const text = 'a你b好c'
  const bytes = Buffer.from(text)

  it('decodes a character split between chunks at any point', () => {
    for (let i = 0; i <= bytes.length; i++) {
      expect(
        decodeAll([bytes.subarray(0, i), bytes.subarray(i)]),
        String(i),
      ).to.equal(text)
    }
  })

  it('decodes a character split across three chunks', () => {
    // 你 is bytes 1 to 3
    const chunks = [
      bytes.subarray(0, 2),
      bytes.subarray(2, 3),
      bytes.subarray(3),
    ]
    expect(decodeAll(chunks)).to.equal(text)
  })

  it('passes strings through', () => {
    expect(decodeAll(['a', Buffer.from('b'), 'c'])).to.equal('abc')
  })

  it('flushes an incomplete character at the end as a replacement character', () => {
    expect(decodeAll([bytes.subarray(0, 2)])).to.equal('a�')
  })
})
