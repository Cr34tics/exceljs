const { Inflate, deflateSync, strToU8, zipSync } = require('fflate')
const fflate = require('fflate')
const {
  zipOf,
  incompressible,
  withDeclaredSize,
  zip64Of,
  zipOfDeflated,
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

      it('reads a small last entry that fits the limit exactly', () => {
        // the last entry starts with less than 64 bytes of the limit left
        const zip = zipOf({
          'a.bin': strToU8('a'.repeat(100)),
          'b.bin': strToU8('b'.repeat(30)),
        })
        const files = unzip(zip, limits({ maxUncompressedSize: 130 }))
        expect(files['b.bin'].length).to.equal(30)
      })

      it('rejects a small entry that lies past the limit with the limit error', () => {
        const lying = withDeclaredSize(
          zipOf({ 'a.bin': strToU8('a'.repeat(1000)) }),
          'a.bin',
          1,
        )
        expect(() => unzip(lying, limits({ maxUncompressedSize: 40 })))
          .to.throw(Error, /maxUncompressedSize/)
          .with.property('code', ZipLimits.ERROR_CODE)
      })

      it('stops inflating at the end of the deflate data', () => {
        // a.bin's record claims the next entry's 16 MiB as its compressed
        // data: pushing all of it after the deflate stream ends costs
        // quadratic time
        const zip = Buffer.from(
          zipSync({
            'a.bin': [strToU8('a'.repeat(100)), { level: 9 }],
            'b.bin': [new Uint8Array(16 * MB), { level: 0 }],
          }),
        )
        const cdOffset = zip.readUInt32LE(zip.length - 22 + 16)
        zip.writeUInt32LE(zip.length - 22 - 60, cdOffset + 20)
        const { push } = fflate.Inflate.prototype
        let pushes = 0
        fflate.Inflate.prototype.push = function (...args) {
          pushes++
          return push.apply(this, args)
        }
        try {
          const files = unzip(zip, limits())
          expect(Buffer.from(files['a.bin']).toString()).to.equal(
            'a'.repeat(100),
          )
        } finally {
          fflate.Inflate.prototype.push = push
        }
        // pushing all of it would take 256 pushes
        expect(pushes).to.be.below(4)
      })

      it('counts what all entries inflate to together', () => {
        // each under-declares, and fits the limit on its own
        const zip = ['a', 'b', 'c'].reduce(
          (lying, entry) => withDeclaredSize(lying, `${entry}.bin`, 1),
          zipOf({
            'a.bin': new Uint8Array(3 * MB),
            'b.bin': new Uint8Array(3 * MB),
            'c.bin': new Uint8Array(3 * MB),
          }),
        )
        expect(() => unzip(zip, limits({ maxUncompressedSize: 4 * MB })))
          .to.throw(Error, /maxUncompressedSize/)
          .with.property('code', ZipLimits.ERROR_CODE)
      })

      it('reads an entry without any deflate data as empty', () => {
        const files = unzip(
          zipOfDeflated('e.bin', new Uint8Array(0), 0),
          limits(),
        )
        expect(files['e.bin'].length).to.equal(0)
      })

      it('reads a zip64 entry that declares more than 4 GiB', () => {
        const content = strToU8('abc'.repeat(1000))
        const files = unzip(
          zip64Of('x.bin', content, 2 ** 32 + 1000),
          limits({ maxUncompressedSize: null }),
        )
        expect(Buffer.from(files['x.bin'])).to.deep.equal(Buffer.from(content))
      })

      it('returns a small entry in a buffer of about its own size', () => {
        const files = unzip(zipOf({ 's.bin': strToU8('small') }), limits())
        expect(Buffer.from(files['s.bin']).toString()).to.equal('small')
        expect(files['s.bin'].buffer.byteLength).to.be.below(64)
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

  it('fails, rather than cuts short, a deflate stream with a long run of empty blocks', () => {
    // 'AAAA', 45,000 empty stored blocks (225 KB of input that inflate to
    // nothing), then 'BBBB'
    const block = (final, data) =>
      Buffer.concat([
        Buffer.from([final ? 1 : 0]),
        Buffer.from([data.length, 0, 255 - data.length, 255]),
        Buffer.from(data),
      ])
    const deflated = Buffer.concat([
      block(false, 'AAAA'),
      ...Array(45000).fill(block(false, '')),
      block(true, 'BBBB'),
    ])
    const zip = zipOfDeflated('p.bin', deflated, 8)
    expect(
      Buffer.from(
        unzipLimited(zip, limits(), unzipLimited.inflateWithZlib)['p.bin'],
      ).toString(),
    ).to.equal('AAAABBBB')
    // fflate's pushes see no output for 128 KiB: it can't tell the data
    // hasn't ended, and fails the entry
    expect(() =>
      unzipLimited(zip, limits(), unzipLimited.inflateWithFflate),
    ).to.throw(Error, 'invalid zip data')
  })

  it('charges a stored entry what it copies, whatever it declares', () => {
    const zip = withDeclaredSize(
      zipOf({ 's.bin': [incompressible(100000), { level: 0 }] }),
      's.bin',
      5,
    )
    expect(() => unzipLimited(zip, limits({ maxUncompressedSize: 1000 })))
      .to.throw(Error, /maxUncompressedSize/)
      .with.property('code', ZipLimits.ERROR_CODE)
  })

  it('rejects a central directory record with a bad signature', () => {
    const zip = zipOf({ 'a.bin': strToU8('a') })
    const cdOffset = zip.readUInt32LE(zip.length - 22 + 16)
    zip.writeUInt32LE(0x12345678, cdOffset)
    expect(() => unzipLimited(zip, limits()))
      .to.throw(Error, 'invalid zip data')
      .with.property('code', 'ERR_INVALID_ZIP')
  })

  it('rejects entry data that runs past the end of the archive', () => {
    const zip = zipOf({ 'a.bin': strToU8('a'.repeat(100)) })
    const cdOffset = zip.readUInt32LE(zip.length - 22 + 16)
    // its compressed size, in the central directory record
    zip.writeUInt32LE(zip.length, cdOffset + 20)
    expect(() => unzipLimited(zip, limits())).to.throw(
      Error,
      'invalid zip data',
    )
  })

  it('rejects an unknown compression method', () => {
    const zip = zipOf({ 'a.bin': strToU8('a'.repeat(100)) })
    const cdOffset = zip.readUInt32LE(zip.length - 22 + 16)
    zip.writeUInt16LE(99, cdOffset + 10)
    expect(() => unzipLimited(zip, limits())).to.throw(
      Error,
      'unknown compression type 99',
    )
  })

  it('reads UTF-8 names, and skips each record’s comment', () => {
    const files = unzipLimited(
      zipOf({
        'ä.bin': [strToU8('a'), { comment: 'a comment' }],
        'b.bin': [strToU8('b'), { comment: 'another' }],
      }),
      limits(),
    )
    expect(Object.keys(files)).to.deep.equal(['ä.bin', 'b.bin'])
    expect(Buffer.from(files['b.bin']).toString()).to.equal('b')
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
