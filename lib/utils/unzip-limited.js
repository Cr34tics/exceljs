const { Inflate, inflateSync, strFromU8 } = require('fflate')
// Only Node's own zlib is used: the browser bundle stubs it as an empty
// module, and a browser polyfill may ignore maxOutputLength
const zlib = require('zlib')

const nodeZlib =
  typeof zlib.inflateRawSync === 'function' &&
  typeof process !== 'undefined' &&
  Boolean(process.versions && process.versions.node) &&
  !process.browser

// Unzips an archive held in memory like fflate's unzipSync, whose central
// directory parsing this mirrors, but with the zip limits enforced.
// unzipSync trusts the size each entry declares: it inflates a deflated entry
// into a buffer of that size and keeps inflating whatever the real size, so
// an entry that under-declares its size costs inflate time no limit sees.
// Here the declared sizes are checked against maxUncompressedSize before
// anything is inflated, which rejects an honest bomb at once, and the bytes
// each entry actually inflates to are counted too, as it inflates, so one
// that lies about its size can't get past the limit either. An entry whose
// declared size is merely wrong is still read in full: that size only sizes
// its first buffer.

// Compressed bytes fed to the streaming inflater at a time, for an entry
// bigger than this. It also bounds the work wasted on the entry that crosses
// the limit (deflate expands at most ~1032x, so ~64 MiB) before the whole
// unzip is abandoned; a smaller entry is inflated in one go for the same cost.
const CHUNK_SIZE = 64 * 1024

function invalid() {
  const error = new Error('invalid zip data')
  error.code = 'ERR_INVALID_ZIP'
  return error
}

function inBounds(d, b, length) {
  if (!(b >= 0 && b + length <= d.byteLength)) {
    throw invalid()
  }
}

// Little-endian reads from a DataView of the archive. Past the end of the data
// they throw, as invalid zip data: a size that silently came out wrong would
// defeat every limit check after it.
function read(get) {
  try {
    return get()
  } catch (error) {
    throw error instanceof RangeError ? invalid() : error
  }
}
function u16(d, b) {
  return read(() => d.getUint16(b, true))
}
function u32(d, b) {
  return read(() => d.getUint32(b, true))
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
  let e = data.byteLength - 22
  while (e < 0 || u32(data, e) !== 0x06054b50) {
    if (e <= 0 || data.byteLength - e > 65558) {
      throw invalid()
    }
    e -= 1
  }
  // A zip64 locator is followed only if the zip64 end record it points to is
  // there: otherwise, like fflate, fall back to the regular record's values
  const z = e >= 20 && u32(data, e - 20) === 0x07064b50 && zip64End(data, e)
  if (z === false) {
    return [u16(data, e + 8), u32(data, e + 16), false]
  }
  // zip64 fields are 8 bytes (fflate reads only their low 4)
  return [u64(data, z + 32), u64(data, z + 48), true]
}

// The offset of the zip64 end of central directory record the zip64 locator
// before the end record at `e` points to, or false if it isn't there
function zip64End(data, e) {
  const high = u32(data, e - 8)
  const z = u32(data, e - 12) + high * 0x100000000
  // the record runs to at least its central directory offset field
  return high < 0x200000 &&
    z + 56 <= data.byteLength &&
    u32(data, z) === 0x06064b50
    ? z
    : false
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
function readEntries(bytes, limits) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
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
    const name = strFromU8(bytes.subarray(b + 46, b + 46 + nameLength), !utf8)
    const extra = b + 46 + nameLength
    const record = {
      size: u32(data, b + 20),
      originalSize: u32(data, b + 24),
      offset: u32(data, b + 42),
    }
    readZip64Fields(data, extra, extraLength, zip64, record)
    const { size, originalSize, offset } = record
    const compression = u16(data, b + 10)
    // a stored entry is copied as is: its compressed size is what it costs
    limits.addBytes(compression === 0 ? size : originalSize)
    entries.push({
      name,
      compression,
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
// reads fflate's internal state. Should that change, inflateWithFflate still
// stops once pushes no longer produce output, and fails the entry.)
function isDone(inflater) {
  return Boolean(inflater.s && inflater.s.f && !inflater.s.l)
}

// Inflates an entry of at most one chunk in one go, into a buffer of its
// declared size plus a byte to notice it inflating past that. Returns
// undefined if it does: it declares too little.
function inflateSmall(compressed, entry, inflated) {
  let out
  try {
    out = inflateSync(compressed, {
      out: new Uint8Array(entry.originalSize + 1),
    })
  } catch {
    // a stored deflate block that doesn't fit throws rather than being cut
    // off (and corrupt data throws again when inflated the other way)
    return undefined
  }
  if (out.length > entry.originalSize) return undefined
  inflated.addBytes(out.length)
  return ownSize(out)
}

// Inflates an entry with fflate, where Node's zlib isn't available (the
// browser). `inflated` counts the bytes entries actually inflate to.
function inflateWithFflate(compressed, entry, inflated) {
  if (compressed.length <= CHUNK_SIZE) {
    const out = inflateSmall(compressed, entry, inflated)
    if (out) return out
    // it declares too little: inflate it whole
    const whole = inflateSync(compressed)
    inflated.addBytes(whole.length)
    return whole
  }
  let out = new Uint8Array(entry.originalSize)
  let length = 0
  const inflater = new Inflate((chunk) => {
    inflated.addBytes(chunk.length)
    if (length + chunk.length > out.length) {
      // It declares too little: grow, but not past what the limit leaves it
      const needed = length + chunk.length
      const allowed =
        needed + (inflated.maxUncompressedSize - inflated.uncompressedSize)
      const grown = new Uint8Array(
        Math.min(Math.max(out.length * 2, needed), allowed),
      )
      grown.set(out.subarray(0, length))
      out = grown
    }
    out.set(chunk, length)
    length += chunk.length
  })
  // Pushes that produced no output in a row. One can legitimately produce
  // none (a stored block of up to 64 KiB straddling two pushes); two can't,
  // so they mean the deflate data has ended, should isDone() stop working.
  let idle = 0
  let i = 0
  for (; i < compressed.length && !isDone(inflater) && idle < 2;) {
    const end = i + CHUNK_SIZE
    const before = length
    inflater.push(compressed.subarray(i, end), end >= compressed.length)
    idle = length === before ? idle + 1 : 0
    i = end
  }
  // Stopped by idle pushes, with data left: rather than cut the entry short,
  // fail it (only a pathological, or truncated, deflate stream gets here)
  if (i < compressed.length && !isDone(inflater)) throw invalid()
  return ownSize(out.subarray(0, length))
}

// Inflates an entry with Node's zlib in one pass, which stops at the end of
// the deflate data and at the limit by itself
function inflateWithZlib(compressed, entry, inflated) {
  // A small entry that declares its size honestly goes straight into a buffer
  // of that size: zlib would take at least a 64 KiB buffer for it
  if (compressed.length <= CHUNK_SIZE && entry.originalSize < MIN_ZLIB_CHUNK) {
    const out = inflateSmall(compressed, entry, inflated)
    if (out) return out
  }
  const left = inflated.maxUncompressedSize - inflated.uncompressedSize
  // a byte more than the limit leaves it, to tell an entry that crosses it
  const maxOutputLength = Math.min(left + 1, MAX_BUFFER_LENGTH)
  let out
  try {
    out = zlib.inflateRawSync(compressed, {
      maxOutputLength,
      // An honest entry inflates into a single buffer of its declared size.
      // zlib takes no chunk under 64 bytes, nor one over 4 GiB (a zip64 size
      // may declare more); one bigger than maxOutputLength is fine, as that
      // still bounds the output.
      chunkSize: Math.max(
        Math.min(
          Math.max(entry.originalSize + 1, MIN_ZLIB_CHUNK),
          maxOutputLength,
          MAX_ZLIB_CHUNK,
        ),
        zlib.constants.Z_MIN_CHUNK,
      ),
    })
  } catch (error) {
    if (error.code !== 'ERR_BUFFER_TOO_LARGE') throw error
    // it inflates past what the limit leaves it
    inflated.addBytes(maxOutputLength)
    throw error
  }
  inflated.addBytes(out.length)
  return ownSize(out)
}

// An entry inflated into a buffer much bigger than itself (one that declares
// too much, or grew past what it declares) is copied, so the buffer can be
// freed rather than kept alive by the entry
function ownSize(out) {
  if (out.buffer.byteLength <= out.length + MIN_ZLIB_CHUNK) return out
  // (Buffer#slice would return a view)
  return Uint8Array.prototype.slice.call(out)
}

// zlib's output chunks: big enough that an entry declaring a tiny size
// doesn't inflate in many small ones
const MIN_ZLIB_CHUNK = 64 * 1024
const MAX_ZLIB_CHUNK = 2 ** 30
const { kMaxLength: MAX_BUFFER_LENGTH } = require('buffer')

const defaultInflate = nodeZlib ? inflateWithZlib : inflateWithFflate

// Returns { [name]: Uint8Array } like unzipSync, stored entries as views of
// `data` (load() copies what it keeps, so `data` must not change until it
// settles). Every entry's declared size is checked against the limits before
// any is inflated.
// Also used with no limits: unzipSync silently truncates an entry that
// inflates past its declared size, where this reads it in full.
function unzipLimited(data, limits, inflate = defaultInflate) {
  const entries = readEntries(data, limits)
  // the bytes entries actually inflate to (their count is already checked)
  const inflated = limits.fresh()
  const files = {}
  entries.forEach((entry) => {
    inBounds(data, entry.dataStart, entry.size)
    const compressed = data.subarray(
      entry.dataStart,
      entry.dataStart + entry.size,
    )
    if (entry.compression === 0) {
      files[entry.name] = compressed
    } else if (entry.compression === 8 && !compressed.length) {
      // no deflate data at all: read as empty, as fflate does (zlib throws)
      files[entry.name] = new Uint8Array(0)
    } else if (entry.compression === 8) {
      files[entry.name] = inflate(compressed, entry, inflated)
    } else {
      throw new Error(`unknown compression type ${entry.compression}`)
    }
  })
  return files
}

module.exports = unzipLimited
// exposed so both inflaters, and the fflate one's reliance on fflate's
// internals, can be tested
module.exports.isDone = isDone
module.exports.inflateWithZlib = inflateWithZlib
module.exports.inflateWithFflate = inflateWithFflate
