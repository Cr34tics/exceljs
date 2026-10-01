const { Inflate, deflateSync, strToU8, zipSync } = require('fflate')
const {
  zipOf,
  incompressible,
  withDeclaredSize,
  zip64Of,
} = require('../../utils/zip-fixtures')

const unzipLimited = verquire('utils/unzip-limited')
const ZipLimits = verquire('utils/zip-limits')

const MB = 1024 * 1024

function limits(options = {}) {
  return new ZipLimits(options, ZipLimits.BUFFERED_DEFAULTS)
}

const INFLATERS = {
  zlib: unzipLimited.inflateWithZlib,
  fflate: unzipLimited.inflateWithFflate,
}

describe('unzipLimited', () => {
  Object.entries(INFLATERS).forEach(([name, inflate]) => {
    describe(`with ${name}`, () => {
      const unzip = (data, zipLimits) => unzipLimited(data, zipLimits, inflate)

      it('reads in full an entry that under-declares its size, with no limits', () => {
        // fflate's unzipSync would silently cut it off at the declared size
        const lying = withDeclaredSize(
          zipOf({ 'bomb.bin': new Uint8Array(MB) }),
          'bomb.bin',
          1,
        )
        const files = unzip(
          lying,
          limits({ maxEntries: null, maxUncompressedSize: null }),
        )
        expect(files['bomb.bin'].length).to.equal(MB)
      })

      it('reads in full a small incompressible entry that under-declares its size', () => {
        // deflated as a stored block, which a too small output buffer can't cut
        // off: fflate throws instead
        const random = incompressible(5000)
        const zip = zipOf({ 'r.bin': random })
        for (const declared of [4998, 1, 0]) {
          const files = unzip(
            withDeclaredSize(zip, 'r.bin', declared),
            limits(),
          )
          expect(Buffer.from(files['r.bin']), String(declared)).to.deep.equal(
            Buffer.from(random),
          )
        }
      })

      it('returns a grown entry in a buffer of its own size', () => {
        // over 64 KiB compressed, so it is inflated in chunks into a buffer that
        // grows past the declared size by doubling
        const random = incompressible(300 * 1024)
        const files = unzip(
          withDeclaredSize(zipOf({ 'r.bin': random }), 'r.bin', 1000),
          limits(),
        )
        expect(Buffer.from(files['r.bin'])).to.deep.equal(Buffer.from(random))
        expect(files['r.bin'].buffer.byteLength).to.equal(random.length)
      })

      it('reads the sizes in a zip64 extra field', () => {
        const content = new Uint8Array(5000).map((_, i) => i % 7)
        const files = unzip(zip64Of('x.bin', content), limits())
        expect(Buffer.from(files['x.bin'])).to.deep.equal(Buffer.from(content))
      })

      it('stops inflating at the end of the deflate data', function () {
        this.timeout(10000)
        // a.bin's record claims the next entry's 16 MiB as its compressed data:
        // pushing all of it after the deflate stream ends costs quadratic time
        const zip = Buffer.from(
          zipSync({
            'a.bin': [strToU8('a'.repeat(100)), { level: 9 }],
            'b.bin': [new Uint8Array(16 * MB), { level: 0 }],
          }),
        )
        const cdOffset = zip.readUInt32LE(zip.length - 22 + 16)
        zip.writeUInt32LE(zip.length - 22 - 60, cdOffset + 20)
        const start = Date.now()
        const files = unzip(zip, limits())
        expect(Date.now() - start).to.be.below(2000)
        expect(Buffer.from(files['a.bin']).toString()).to.equal('a'.repeat(100))
      })

      it('charges a deflated entry its uncompressed size only', () => {
        // random bytes deflate to a little more than their own size
        const random = incompressible(100000)
        const files = unzip(
          zipOf({ 'r.bin': random }),
          limits({ maxUncompressedSize: 100000 }),
        )
        expect(files['r.bin'].length).to.equal(100000)
      })
    })
  })

  it('inflates each entry once with zlib, however wrong its declared size', () => {
    const zlib = require('zlib')
    const { inflateRawSync } = zlib
    let calls = 0
    zlib.inflateRawSync = (...args) => {
      calls++
      return inflateRawSync(...args)
    }
    try {
      const random = incompressible(5000)
      const files = unzipLimited(
        withDeclaredSize(zipOf({ 'r.bin': random }), 'r.bin', 1),
        limits(),
        unzipLimited.inflateWithZlib,
      )
      expect(Buffer.from(files['r.bin'])).to.deep.equal(Buffer.from(random))
      expect(calls).to.equal(1)
    } finally {
      zlib.inflateRawSync = inflateRawSync
    }
  })

  it('returns an entry that over-declares its size in a buffer of its own size', () => {
    for (const inflate of Object.values(INFLATERS)) {
      const files = unzipLimited(
        withDeclaredSize(
          zipOf({ 'a.bin': strToU8('a'.repeat(1000)) }),
          'a.bin',
          10 * MB,
        ),
        limits(),
        inflate,
      )
      expect(files['a.bin'].length).to.equal(1000)
      expect(files['a.bin'].buffer.byteLength).to.be.below(MB)
    }
  })

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
