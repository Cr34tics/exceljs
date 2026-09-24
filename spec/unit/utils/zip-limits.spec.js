const ZipLimits = verquire('utils/zip-limits')

const GiB = 1024 * 1024 * 1024

function catchError(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

describe('ZipLimits', () => {
  describe('defaults', () => {
    it('are 10000 entries and 1 GiB for buffered reads', () => {
      const limits = new ZipLimits({}, ZipLimits.BUFFERED_DEFAULTS)
      expect(limits.maxEntries).to.equal(10000)
      expect(limits.maxUncompressedSize).to.equal(1 * GiB)
      expect(limits.enabled).to.equal(true)
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
        expect(limits.maxEntries).to.be.undefined()
        expect(limits.maxUncompressedSize).to.be.undefined()
        expect(limits.enabled).to.equal(false)
        limits.addEntry()
        limits.addBytes(8 * GiB)
      }
    })

    it('are unlimited when no defaults are given', () => {
      expect(new ZipLimits({}).enabled).to.equal(false)
    })
  })

  it('rejects invalid values', () => {
    for (const value of [-1, NaN, '10', {}]) {
      const error = catchError(() => new ZipLimits({ maxEntries: value }))
      expect(error, String(value)).to.be.an.instanceOf(TypeError)
    }
  })

  it('allows reaching a limit but not exceeding it', () => {
    const limits = new ZipLimits({ maxEntries: 1, maxUncompressedSize: 10 })
    limits.addEntry()
    limits.addBytes(10)
    const entryError = catchError(() => limits.addEntry())
    expect(entryError.code).to.equal('ERR_ZIP_LIMIT_EXCEEDED')
    const sizeError = catchError(() => limits.addBytes(1))
    expect(sizeError.code).to.equal(ZipLimits.ERROR_CODE)
  })
})
