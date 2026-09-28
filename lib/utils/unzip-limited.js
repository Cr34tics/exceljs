const { Inflate, inflateSync, strFromU8 } = require('fflate')
const { createLimitError } = require('./zip-limits')

// Unzips an archive held in memory like fflate's unzipSync, whose central
// directory parsing this mirrors, but with the zip limits enforced. unzipSync
// trusts the size each entry declares: it inflates a deflated entry in one go
// into a buffer of that size, and keeps inflating whatever the real size. So
// an entry that under-declares its size costs inflate time the limits never
// see. Here each entry is inflated in chunks and abandoned as soon as it
// grows past its declared size, and the declared sizes are what count towards
// maxUncompressedSize, so the total inflate work stays within the limit.

// Compressed bytes fed to the inflater at a time. It also bounds the work
// wasted on the one entry that inflates past its declared size (deflate
// expands at most ~1032x, so ~64 MiB) before the whole unzip is abandoned.
const CHUNK_SIZE = 64 * 1024

function invalid() {
  return new Error('invalid zip data')
}

// Little-endian reads that throw rather than yield NaN past the end of the
// data: a NaN size would silently defeat every limit check after it
function inBounds(d, b, length) {
  if (!(b >= 0 && b + length <= d.length)) {
    throw invalid()
  }
}
function u16(d, b) {
  inBounds(d, b, 2)
  return d[b] + d[b + 1] * 0x100
}
function u32(d, b) {
  inBounds(d, b, 4)
  return d[b] + d[b + 1] * 0x100 + d[b + 2] * 0x10000 + d[b + 3] * 0x1000000
}
function u64(d, b) {
  const high = u32(d, b + 4)
  // a Number holds integers exactly only up to 2^53; no real archive has a
  // size, offset or entry count anywhere near that
  if (high >= 0x200000) {
    throw invalid()
  }
  return u32(d, b) + high * 0x100000000
}

// End of central directory: returns [entry count, central directory offset,
// zip64]
function readEnd(data) {
  let e = data.length - 22
  while (e < 0 || u32(data, e) !== 0x06054b50) {
    if (e <= 0 || data.length - e > 65558) {
      throw invalid()
    }
    e -= 1
  }
  let count = u16(data, e + 8)
  let offset = u32(data, e + 16)
  let zip64 = e >= 20 && u32(data, e - 20) === 0x07064b50
  if (zip64) {
    // zip64 fields are 8 bytes (fflate reads only their low 4)
    const z = u64(data, e - 12)
    zip64 = u32(data, z) === 0x06064b50
    if (zip64) {
      count = u64(data, z + 32)
      offset = u64(data, z + 48)
    }
  }
  return [count, offset, zip64]
}

// The values a zip64 extra field can replace, in the order it lists them
const ZIP64_FIELDS = ['originalSize', 'size', 'offset']

// Replaces the sizes and local header offset of a central directory record
// that are marked 0xffffffff with the values in its zip64 extra field
function readZip64Fields(data, extra, extraLength, zip64, record) {
  const replaced = ZIP64_FIELDS.filter((name) => record[name] === 0xffffffff)
  if (!zip64 || !replaced.length) {
    return
  }
  const end = extra + extraLength
  for (let b = extra; b + 4 < end; b += 4 + u16(data, b + 2)) {
    if (u16(data, b) === 1) {
      // the field lists only the values it replaces, each within the field's
      // own length (past it lie the next field or record)
      const fieldEnd = Math.min(b + 4 + u16(data, b + 2), end)
      replaced.forEach((name, i) => {
        const field = b + 4 + i * 8
        if (field + 8 > fieldEnd) {
          throw invalid()
        }
        record[name] = u64(data, field)
      })
      return
    }
  }
  throw invalid()
}

// Reads the central directory, checking its stated entry count against
// maxEntries before walking any record, then each record's size
function readEntries(data, limits) {
  const [count, start, zip64] = readEnd(data)
  limits.checkEntryCount(count)
  const entries = []
  let b = start
  for (let i = 0; i < count; i++) {
    if (u32(data, b) !== 0x02014b50) {
      throw invalid()
    }
    const nameLength = u16(data, b + 28)
    const extraLength = u16(data, b + 30)
    // general purpose flag bit 11: the name is UTF-8, otherwise CP437/latin1
    const utf8 = Math.floor(u16(data, b + 8) / 0x800) % 2 === 1
    inBounds(data, b + 46, nameLength + extraLength)
    const name = strFromU8(data.subarray(b + 46, b + 46 + nameLength), !utf8)
    const extra = b + 46 + nameLength
    const record = {
      size: u32(data, b + 20),
      originalSize: u32(data, b + 24),
      offset: u32(data, b + 42),
    }
    readZip64Fields(data, extra, extraLength, zip64, record)
    const { size, originalSize, offset } = record
    // a stored entry is copied as is: its compressed size is what it costs
    limits.addBytes(Math.max(size, originalSize))
    entries.push({
      name,
      compression: u16(data, b + 10),
      size,
      originalSize,
      // local header: fixed 30 bytes, then its own name and extra field
      dataStart: offset + 30 + u16(data, offset + 26) + u16(data, offset + 28),
    })
    b = extra + extraLength + u16(data, b + 32)
  }
  return entries
}

// Whether fflate's Inflate has decoded the final deflate block. Pushing more
// input after that would still be buffered, at a cost quadratic in its size,
// so an entry that over-declares its compressed size must stop there. (It
// reads fflate's internal state: should that change, this only costs time.)
function isDone(inflater) {
  return Boolean(inflater.s && inflater.s.f && !inflater.s.l)
}

function inflateEntry(compressed, entry, limits) {
  if (limits.maxUncompressedSize === Infinity) {
    // no limit to hold the entry to: inflate it whole, whatever its size
    return inflateSync(compressed)
  }
  const tooBig = () =>
    createLimitError(
      `Zip entry ${entry.name} inflates to more than the ${entry.originalSize} bytes it declares (maxUncompressedSize)`,
    )
  if (compressed.length <= CHUNK_SIZE) {
    // At most one chunk: inflating it in one go wastes no more than a chunk
    // would, and skips the streaming inflater's setup, which dominates for
    // the many small parts of a workbook
    const out = inflateSync(compressed)
    if (out.length > entry.originalSize) throw tooBig()
    return out
  }
  const out = new Uint8Array(entry.originalSize)
  let length = 0
  const inflater = new Inflate((chunk) => {
    if (length + chunk.length > out.length) {
      throw tooBig()
    }
    out.set(chunk, length)
    length += chunk.length
  })
  for (let i = 0; i < compressed.length && !isDone(inflater); i += CHUNK_SIZE) {
    const end = i + CHUNK_SIZE
    inflater.push(compressed.subarray(i, end), end >= compressed.length)
  }
  return length === out.length ? out : out.subarray(0, length)
}

// Returns { [name]: Uint8Array } like unzipSync, stored entries as views of
// `data` (load() copies what it keeps). Every entry is checked against the
// limits before any is inflated.
// Also used with no limits: unzipSync silently truncates an entry that
// inflates past its declared size, where this reads it in full.
function unzipLimited(data, limits) {
  const entries = readEntries(data, limits)
  const files = {}
  entries.forEach((entry) => {
    inBounds(data, entry.dataStart, entry.size)
    const compressed = data.subarray(
      entry.dataStart,
      entry.dataStart + entry.size,
    )
    if (entry.compression === 0) {
      files[entry.name] = compressed
    } else if (entry.compression === 8) {
      files[entry.name] = inflateEntry(compressed, entry, limits)
    } else {
      throw new Error(`unknown compression type ${entry.compression}`)
    }
  })
  return files
}

module.exports = unzipLimited
