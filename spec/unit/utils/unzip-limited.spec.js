const fflate = require('fflate')

const { Inflate, deflateSync, strToU8, zipSync } = fflate
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

// `fn` throws the maxUncompressedSize limit's error
function expectLimitError(fn) {
  expect(fn)
    .to.throw(Error, /maxUncompressedSize/)
    .with.property('code', ZipLimits.ERROR_CODE)
}

// `fn` throws the invalid-archive error
function expectInvalidZip(fn) {
  expect(fn)
    .to.throw(Error, 'invalid zip data')
    .with.property('code', 'ERR_INVALID_ZIP')
}

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
        expectLimitError(() =>
          unzip(lying, limits({ maxUncompressedSize: 40 })),
        )
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
        expectLimitError(() =>
          unzip(zip, limits({ maxUncompressedSize: 4 * MB })),
        )
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

  it('inflates with zlib bounded by the declared size, then by the limit', () => {
    const zlib = require('zlib')
    const { inflateRawSync } = zlib
    const bounds = []
    zlib.inflateRawSync = (data, options) => {
      bounds.push(options.maxOutputLength)
      return inflateRawSync(data, options)
    }
    try {
      // a small entry that declares too little stops at its declared size,
      // and is inflated again, counted, bounded by what the limit leaves
      const random = incompressible(5000)
      const files = unzipLimited(
        withDeclaredSize(zipOf({ 'r.bin': random }), 'r.bin', 1),
        limits({ maxUncompressedSize: 10 * MB }),
        unzipLimited.inflateWithZlib,
      )
      expect(Buffer.from(files['r.bin'])).to.deep.equal(Buffer.from(random))
      expect(bounds).to.deep.equal([2, 10 * MB + 1])

      // a bomb that declares a small size never inflates past the limit
      bounds.length = 0
      expectLimitError(() =>
        unzipLimited(
          withDeclaredSize(
            zipOf({ 'b.bin': new Uint8Array(8 * MB) }),
            'b.bin',
            100 * 1024,
          ),
          limits({ maxUncompressedSize: MB }),
          unzipLimited.inflateWithZlib,
        ),
      )
      // bounded by its declared size, then by the limit in small chunks
      expect(bounds).to.deep.equal([100 * 1024 + 1, MB + 1])
    } finally {
      zlib.inflateRawSync = inflateRawSync
    }
  })

  it('inflates with fflate, and enforces the limits, in a browser bundle', () => {
    // load a copy as the browser bundle sees it
    const file = Object.keys(require.cache).find(
      (name) => require.cache[name].exports === unzipLimited,
    )
    const cached = require.cache[file]
    const zlib = require('zlib')
    const { inflateRawSync } = zlib
    let zlibCalls = 0
    zlib.inflateRawSync = (...args) => {
      zlibCalls++
      return inflateRawSync(...args)
    }
    process.browser = true
    try {
      delete require.cache[file]
      // eslint-disable-next-line import-x/no-dynamic-require
      const browserUnzip = require(file)
      const bomb = withDeclaredSize(
        zipOf({ 'b.bin': new Uint8Array(8 * MB) }),
        'b.bin',
        1,
      )
      expectLimitError(() =>
        browserUnzip(bomb, limits({ maxUncompressedSize: MB })),
      )
      const files = browserUnzip(zipOf({ 's.txt': strToU8('small') }), limits())
      expect(Buffer.from(files['s.txt']).toString()).to.equal('small')
      expect(zlibCalls).to.equal(0)
    } finally {
      delete process.browser
      require.cache[file] = cached
      zlib.inflateRawSync = inflateRawSync
    }
  })

  it('keeps no big buffer for small entries that declare too little', () => {
    const files = {}
    for (let i = 0; i < 50; i++) files[`e${i}.bin`] = incompressible(1000)
    let lying = zipOf(files)
    for (let i = 0; i < 50; i++) lying = withDeclaredSize(lying, `e${i}.bin`, 1)
    for (const inflate of Object.values(INFLATERS)) {
      const out = unzipLimited(lying, limits(), inflate)
      Object.values(out).forEach((entry) => {
        expect(entry.length).to.equal(1000)
        expect(entry.buffer.byteLength).to.be.at.most(2000)
      })
    }
  })

  it('inflates an entry that declares too little in small chunks with zlib', () => {
    const zlib = require('zlib')
    const { inflateRawSync } = zlib
    const calls = []
    zlib.inflateRawSync = (data, options) => {
      calls.push(options)
      return inflateRawSync(data, options)
    }
    // the output buffers zlib allocates
    const { allocUnsafe } = Buffer
    const big = []
    Buffer.allocUnsafe = (size, ...rest) => {
      if (size >= MB) big.push(size)
      return allocUnsafe.call(Buffer, size, ...rest)
    }
    try {
      // declares 1 MiB of the 2 MiB limit, inflates to 8 MiB: the second
      // pass mustn't take a chunk of its declared size past the limit
      expectLimitError(() =>
        unzipLimited(
          withDeclaredSize(
            zipOf({ 'b.bin': new Uint8Array(8 * MB) }),
            'b.bin',
            MB,
          ),
          limits({ maxUncompressedSize: 2 * MB }),
          unzipLimited.inflateWithZlib,
        ),
      )
      expect(calls.map((c) => c.maxOutputLength)).to.deep.equal([
        MB + 1,
        2 * MB + 1,
      ])
      // one chunk, a byte over the bound: zlib then stops at the first
      expect(calls[0].chunkSize).to.equal(MB + 2)
      expect(calls[1].chunkSize).to.equal(64 * 1024)
      // never a second chunk of its declared size
      expect(big).to.deep.equal([MB + 2])
    } finally {
      zlib.inflateRawSync = inflateRawSync
      Buffer.allocUnsafe = allocUnsafe
    }
  })

  it('reads an entry whose declared size is too big to allocate, with no limits', () => {
    const content = incompressible(200 * 1024)
    for (const inflate of Object.values(INFLATERS)) {
      const files = unzipLimited(
        zip64Of('x.bin', content, 2 ** 46),
        limits({ maxUncompressedSize: null }),
        inflate,
      )
      expect(Buffer.from(files['x.bin'])).to.deep.equal(Buffer.from(content))
    }
  })

  // Spies on zlib.inflateRawSync for `fn`, returning the options of each call
  function zlibCallsOf(fn) {
    const zlib = require('zlib')
    const { inflateRawSync } = zlib
    const calls = []
    zlib.inflateRawSync = (data, options) => {
      calls.push(options)
      return inflateRawSync(data, options)
    }
    try {
      fn()
    } finally {
      zlib.inflateRawSync = inflateRawSync
    }
    return calls
  }

  it('inflates an entry that declares all the limit leaves it once, with zlib', () => {
    // declares exactly the limit and inflates past it: a second pass would
    // be bounded the same, and could only fail the same way
    const calls = zlibCallsOf(() =>
      expectLimitError(() =>
        unzipLimited(
          withDeclaredSize(
            zipOf({ 'b.bin': new Uint8Array(8 * MB) }),
            'b.bin',
            MB,
          ),
          limits({ maxUncompressedSize: MB }),
          unzipLimited.inflateWithZlib,
        ),
      ),
    )
    expect(calls.map((c) => c.maxOutputLength)).to.deep.equal([MB + 1])
  })

  it('inflates an entry declaring over 1 GiB in small chunks only, with zlib', () => {
    // a first pass would take a 1 GiB chunk, and a liar could fill another
    const content = strToU8('x'.repeat(1000))
    let files
    const calls = zlibCallsOf(() => {
      files = unzipLimited(
        zip64Of('x.bin', content, 2 ** 31),
        limits({ maxUncompressedSize: null }),
        unzipLimited.inflateWithZlib,
      )
    })
    expect(Buffer.from(files['x.bin'])).to.deep.equal(Buffer.from(content))
    expect(calls.map((c) => c.chunkSize)).to.deep.equal([64 * 1024])
  })

  it('counts stored entries towards the same total as inflated ones', () => {
    const zip = withDeclaredSize(
      zipOf({
        'a.bin': [incompressible(900 * 1024), { level: 0 }],
        'b.bin': new Uint8Array(900 * 1024),
      }),
      'b.bin',
      0,
    )
    for (const inflate of Object.values(INFLATERS)) {
      expectLimitError(() =>
        unzipLimited(zip, limits({ maxUncompressedSize: MB }), inflate),
      )
    }
  })

  it('grows an entry that declares too little no further than the limit, with fflate', () => {
    const zip = withDeclaredSize(
      zipOf({ 'r.bin': incompressible(900 * 1024) }),
      'r.bin',
      100 * 1024,
    )
    // the buffers it allocates for the entry
    const sizes = []
    const Real = Uint8Array
    global.Uint8Array = class extends Real {
      constructor(...args) {
        super(...args)
        if (typeof args[0] === 'number') sizes.push(args[0])
      }
    }
    let files
    try {
      files = unzipLimited(
        zip,
        limits({ maxUncompressedSize: MB }),
        unzipLimited.inflateWithFflate,
      )
    } finally {
      global.Uint8Array = Real
    }
    expect(files['r.bin'].length).to.equal(900 * 1024)
    expect(Math.max(...sizes)).to.be.at.most(MB)
  })

  it('reads an archive with a zip64 end record and ordinary 32-bit records', () => {
    // as written by tools that always add a zip64 end record
    const zip = zipOf({ 'a.txt': strToU8('hello') })
    const eocd = zip.length - 22
    const count = zip.readUInt16LE(eocd + 10)
    const cdSize = zip.readUInt32LE(eocd + 12)
    const cdOffset = zip.readUInt32LE(eocd + 16)
    const zip64End = Buffer.alloc(56)
    zip64End.writeUInt32LE(0x06064b50, 0)
    zip64End.writeBigUInt64LE(44n, 4)
    zip64End.writeUInt16LE(45, 12)
    zip64End.writeUInt16LE(45, 14)
    zip64End.writeBigUInt64LE(BigInt(count), 24)
    zip64End.writeBigUInt64LE(BigInt(count), 32)
    zip64End.writeBigUInt64LE(BigInt(cdSize), 40)
    zip64End.writeBigUInt64LE(BigInt(cdOffset), 48)
    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(0x07064b50, 0)
    locator.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8)
    locator.writeUInt32LE(1, 16)
    const withZip64End = Buffer.concat([
      zip.subarray(0, eocd),
      zip64End,
      locator,
      zip.subarray(eocd),
    ])
    for (const inflate of Object.values(INFLATERS)) {
      const files = unzipLimited(withZip64End, limits(), inflate)
      expect(Buffer.from(files['a.txt']).toString()).to.equal('hello')
    }
  })

  describe('rejects with ERR_INVALID_ZIP', () => {
    const expectInvalid = (data) =>
      expectInvalidZip(() => unzipLimited(data, limits()))
    const zip = () => Buffer.from(zipOf({ 'a.txt': strToU8('hello') }))
    const cdOffset = (data) => data.readUInt32LE(data.length - 22 + 16)

    it('a local header offset past the end of the data', () => {
      const data = zip()
      data.writeUInt32LE(0x7fffffff, cdOffset(data) + 42)
      expectInvalid(data)
    })

    it('a central directory offset past the end of the data', () => {
      const data = zip()
      data.writeUInt32LE(0x7fffffff, data.length - 22 + 16)
      expectInvalid(data)
    })

    it('a record whose name runs past the end of the data', () => {
      const data = zip()
      data.writeUInt16LE(60000, cdOffset(data) + 28)
      expectInvalid(data)
    })

    it('an entry that declares content but has no deflate data', () => {
      expectInvalid(zipOfDeflated('e.bin', new Uint8Array(0), 5))
    })

    it('deflate data that cannot be inflated, with the inflater error as its cause', () => {
      const corrupt = zipOfDeflated('c.bin', new Uint8Array(64).fill(0xff), 10)
      for (const inflate of Object.values(INFLATERS)) {
        let error
        try {
          unzipLimited(corrupt, limits(), inflate)
        } catch (e) {
          error = e
        }
        expect(error && error.code).to.equal('ERR_INVALID_ZIP')
        expect(error.cause).to.be.an.instanceOf(Error)
      }
    })

    it('an end record further from the end than its comment can reach', () => {
      expectInvalid(Buffer.concat([zip(), Buffer.alloc(70 * 1024)]))
    })
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
    expectInvalidZip(() =>
      unzipLimited(zip, limits(), unzipLimited.inflateWithFflate),
    )
  })

  it('charges a stored entry what it copies, whatever it declares', () => {
    const zip = withDeclaredSize(
      zipOf({ 's.bin': [incompressible(100000), { level: 0 }] }),
      's.bin',
      5,
    )
    expectLimitError(() =>
      unzipLimited(zip, limits({ maxUncompressedSize: 1000 })),
    )
  })

  it('rejects a compression method it cannot read as unsupported', () => {
    const zip = Buffer.from(zipOf({ 'a.txt': strToU8('hello'.repeat(50)) }))
    const cdOffset = zip.readUInt32LE(zip.length - 22 + 16)
    // Deflate64
    zip.writeUInt16LE(9, cdOffset + 10)
    expect(() => unzipLimited(zip, limits()))
      .to.throw(Error, /compression/)
      .with.property('code', 'ERR_UNSUPPORTED_ZIP_COMPRESSION')
  })

  it('rejects a central directory record with a bad signature', () => {
    const zip = zipOf({ 'a.bin': strToU8('a') })
    const cdOffset = zip.readUInt32LE(zip.length - 22 + 16)
    zip.writeUInt32LE(0x12345678, cdOffset)
    expectInvalidZip(() => unzipLimited(zip, limits()))
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
