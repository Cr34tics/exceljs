const { PassThrough } = require('stream')
const { finished } = require('stream/promises')

const iterateStream = verquire('utils/iterate-stream')

async function collect(stream) {
  const chunks = []
  for await (const chunk of iterateStream(stream)) {
    chunks.push(chunk.toString())
  }
  return chunks
}

describe('iterateStream', () => {
  it('yields each chunk until the stream ends', async () => {
    const stream = new PassThrough()
    stream.write('a')
    stream.end('b')
    expect((await collect(stream)).join('')).to.equal('ab')
  })

  it('throws the error of a stream that already failed', async () => {
    const stream = new PassThrough()
    stream.on('error', () => {})
    stream.destroy(new Error('boom'))
    let error
    try {
      await collect(stream)
    } catch (e) {
      error = e
    }
    expect(error).to.be.an.instanceOf(Error)
    expect(error.message).to.equal('boom')
  })

  it('throws for a stream that was already consumed', async () => {
    const stream = new PassThrough()
    stream.end('a')
    stream.resume()
    await finished(stream)
    let error
    try {
      await collect(stream)
    } catch (e) {
      error = e
    }
    expect(error).to.be.an.instanceOf(Error)
    expect(error.message).to.match(/already consumed/)
  })

  it('stops collecting chunks once the consumer stops early', async () => {
    // Otherwise draining the rest of the stream would buffer all of it
    const stream = new PassThrough()
    stream.write('a')
    for await (const chunk of iterateStream(stream)) {
      expect(chunk.toString()).to.equal('a')
      break
    }
    expect(stream.listenerCount('data')).to.equal(0)
  })
})
