const { Inflate, deflateSync } = require('fflate')

const unzipLimited = verquire('utils/unzip-limited')

describe('unzipLimited', () => {
  describe('isDone', () => {
    // It reads fflate's internal state to stop feeding an entry past the end
    // of its deflate data; this pins that reliance to the fflate in use
    it('tells when the inflater has decoded the final block', () => {
      const inflater = new Inflate(() => {})
      expect(unzipLimited.isDone(inflater)).to.equal(false)
      const deflated = deflateSync(new Uint8Array(1000).fill(7))
      // pushed without the final flag, as the chunk loop does mid-entry
      inflater.push(deflated.subarray(0, 5))
      expect(unzipLimited.isDone(inflater)).to.equal(false)
      inflater.push(deflated.subarray(5))
      expect(unzipLimited.isDone(inflater)).to.equal(true)
    })
  })
})
