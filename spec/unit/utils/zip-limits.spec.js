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

    it('are unlimited when no defaults are given', () => {
      const limits = new ZipLimits({})
      expect(limits.maxEntries).to.equal(Infinity)
      expect(limits.maxUncompressedSize).to.equal(Infinity)
    })
  })

  it('rejects invalid values', () => {
    for (const value of [-1, NaN, '10', {}]) {
      expect(
        () => new ZipLimits({ maxEntries: value }),
        String(value),
      ).to.throw(TypeError)
    }
  })

  it('allows reaching a limit but not exceeding it', () => {
    const limits = new ZipLimits({ maxEntries: 1, maxUncompressedSize: 10 })
    limits.addEntry()
    limits.addBytes(10)
    expect(() => limits.addEntry())
      .to.throw(Error, /maxEntries/)
      .with.property('code', 'ERR_ZIP_LIMIT_EXCEEDED')
    expect(() => limits.addBytes(1))
      .to.throw(Error, /maxUncompressedSize/)
      .with.property('code', ZipLimits.ERROR_CODE)
  })
})
