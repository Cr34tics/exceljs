const { Inflate, strFromU8, unzipSync } = require('fflate')
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
// expands at most ~1032x, so ~16 MiB) before the whole unzip is abandoned.
const CHUNK_SIZE = 16 * 1024

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
  return u32(d, b) + u32(d, b + 4) * 0x100000000
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

// Sizes and local header offset of a central directory record, taking them
// from its zip64 extra field where the record says so
function readSizes(data, extra, extraLength, zip64, sizes) {
  const [compressed, uncompressed, offset] = sizes
  const inExtra = sizes.map((value) => value === 0xffffffff)
  if (!zip64 || !inExtra.some(Boolean)) {
    return sizes
  }
  const end = extra + extraLength
  for (let b = extra; b + 4 < end; b += 4 + u16(data, b + 2)) {
    if (u16(data, b) === 1) {
      // the zip64 extra field lists only the values it replaces, in the order
      // uncompressed, compressed, offset
      let field = b + 4
      const next = () => {
        const value = u64(data, field)
        field += 8
        return value
      }
      const u = inExtra[1] ? next() : uncompressed
      const c = inExtra[0] ? next() : compressed
      const o = inExtra[2] ? next() : offset
      return [c, u, o]
    }
  }
  throw invalid()
}

// Reads the central directory, checking its stated entry count and then each
// record against the limits, so an archive over maxEntries is rejected
// without walking more than maxEntries + 1 records
function readEntries(data, limits) {
  const [count, start, zip64] = readEnd(data)
  limits.checkEntryCount(count)
  const entries = []
  let b = start
  for (let i = 0; i < count; i++) {
    limits.addEntry()
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
    const [size, originalSize, offset] = readSizes(
      data,
      extra,
      extraLength,
      zip64,
      [u32(data, b + 20), u32(data, b + 24), u32(data, b + 42)],
    )
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

function inflateEntry(compressed, entry, limits) {
  const strict = limits.maxUncompressedSize !== Infinity
  let out = new Uint8Array(entry.originalSize)
  let length = 0
  const inflater = new Inflate((chunk) => {
    if (length + chunk.length > out.length) {
      if (strict) {
        throw createLimitError(
          `Zip entry ${entry.name} inflates to more than the ${entry.originalSize} bytes it declares (maxUncompressedSize)`,
        )
      }
      const grown = new Uint8Array(
        Math.max(out.length * 2, length + chunk.length),
      )
      grown.set(out.subarray(0, length))
      out = grown
    }
    out.set(chunk, length)
    length += chunk.length
  })
  if (!compressed.length) {
    inflater.push(compressed, true)
  }
  for (let i = 0; i < compressed.length; i += CHUNK_SIZE) {
    const end = i + CHUNK_SIZE
    inflater.push(compressed.subarray(i, end), end >= compressed.length)
  }
  return length === out.length ? out : out.subarray(0, length)
}

// Returns { [name]: Uint8Array } like unzipSync. Every entry is checked against
// the limits before any is inflated.
function unzipLimited(data, limits) {
  if (
    limits.maxEntries === Infinity &&
    limits.maxUncompressedSize === Infinity
  ) {
    // no limits to enforce: fflate's one-shot inflate is the cheapest path
    return unzipSync(data)
  }
  const entries = readEntries(data, limits)
  const files = {}
  entries.forEach((entry) => {
    const compressed = data.subarray(
      entry.dataStart,
      entry.dataStart + entry.size,
    )
    if (compressed.length !== entry.size) {
      throw invalid()
    }
    if (entry.compression === 0) {
      files[entry.name] = compressed.slice()
    } else if (entry.compression === 8) {
      files[entry.name] = inflateEntry(compressed, entry, limits)
    } else {
      throw new Error(`unknown compression type ${entry.compression}`)
    }
  })
  return files
}

module.exports = unzipLimited
