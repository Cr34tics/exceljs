const ZipLimits = verquire('utils/zip-limits')

const GiB = 1024 * 1024 * 1024

describe('ZipLimits', () => {
  describe('defaults', () => {
    it('are 10000 entries and 1 GiB for buffered reads', () => {
      const limits = new ZipLimits({}, ZipLimits.BUFFERED_DEFAULTS)
      expect(limits.maxEntries).to.equal(10000)
      expect(limits.maxUncompressedSize).to.equal(1 * GiB)
    })

    it('are 10000 entries and 4 GiB for streaming reads', () => {
      const limits = new ZipLimits(undefined, ZipLimits.STREAMING_DEFAULTS)
      expect(limits.maxEntries).to.equal(10000)
      expect(limits.maxUncompressedSize).to.equal(4 * GiB)
    })

    it('are overridden by explicit numbers', () => {
      const limits = new ZipLimits(
        { maxEntries: 5, maxUncompressedSize: 0 },
        ZipLimits.BUFFERED_DEFAULTS,
      )
      expect(limits.maxEntries).to.equal(5)
      expect(limits.maxUncompressedSize).to.equal(0)
    })

    it('are disabled by null or Infinity', () => {
      for (const value of [null, Infinity]) {
        const limits = new ZipLimits(
          { maxEntries: value, maxUncompressedSize: value },
          ZipLimits.BUFFERED_DEFAULTS,
        )
        expect(limits.maxEntries).to.equal(Infinity)
        expect(limits.maxUncompressedSize).to.equal(Infinity)
        limits.addEntry()
        limits.addBytes(8 * GiB)
      }
    })
  })

  it('rejects invalid values', () => {
    const invalid = [-1, NaN, '10', {}, 1.5, 0.5, 2 ** 53, -Infinity]
    for (const name of ['maxEntries', 'maxUncompressedSize']) {
      for (const value of invalid) {
        expect(
          () => new ZipLimits({ [name]: value }, ZipLimits.BUFFERED_DEFAULTS),
          `${name}: ${value}`,
        ).to.throw(TypeError)
      }
    }
  })

  it('ignores limits inherited from the prototype', () => {
    for (const name of ['maxEntries', 'maxUncompressedSize']) {
      Object.defineProperty(Object.prototype, name, {
        value: null,
        configurable: true,
        writable: true,
      })
      try {
        const limits = new ZipLimits({}, ZipLimits.BUFFERED_DEFAULTS)
        expect(limits[name]).to.equal(ZipLimits.BUFFERED_DEFAULTS[name])
      } finally {
        delete Object.prototype[name]
      }
    }
  })

  it('allows reaching a limit but not exceeding it', () => {
    const limits = new ZipLimits(
      { maxEntries: 1, maxUncompressedSize: 10 },
      ZipLimits.BUFFERED_DEFAULTS,
    )
    limits.addEntry()
    limits.addBytes(10)
    expect(() => limits.addEntry())
      .to.throw(Error, /maxEntries/)
      .with.property('code', 'ERR_ZIP_LIMIT_EXCEEDED')
    expect(() => limits.addBytes(1))
      .to.throw(Error, /maxUncompressedSize/)
      .with.property('code', ZipLimits.ERROR_CODE)
  })

  it('rejects a size that is not a non-negative safe integer', () => {
    const limits = new ZipLimits(
      { maxUncompressedSize: 10 },
      ZipLimits.BUFFERED_DEFAULTS,
    )
    for (const size of [NaN, -1, Infinity, undefined, 1.5]) {
      expect(() => limits.addBytes(size), String(size)).to.throw(TypeError)
    }
  })
})
