// Builders for crafted zip archives, shared by the zip limit specs
const { randomBytes } = require('crypto')
const { unzipSync, zipSync } = require('fflate')

// Zips `files` ({ [name]: Uint8Array | [Uint8Array, options] })
function zipOf(files) {
  return Buffer.from(zipSync(files, { level: 9 }))
}

// Re-zips an archive, letting `edit` add, replace or reorder entries
function rezip(buffer, edit = (files) => files) {
  return zipOf(edit(unzipSync(buffer)))
}

// Bytes deflate can't compress
function incompressible(size) {
  return new Uint8Array(randomBytes(size))
}

// Rewrites the uncompressed size declared in the central directory, which is
// what the buffered reader trusts when allocating output
function withDeclaredSize(buffer, entryName, size) {
  const out = Buffer.from(buffer)
  for (let i = out.length - 46; i >= 0; i--) {
    if (out.readUInt32LE(i) === 0x02014b50) {
      const nameLength = out.readUInt16LE(i + 28)
      const name = out.toString('latin1', i + 46, i + 46 + nameLength)
      if (name === entryName) {
        out.writeUInt32LE(size, i + 24)
        return out
      }
    }
  }
  throw new Error(`entry not found: ${entryName}`)
}

// A zip64 archive of one deflated entry whose central directory record keeps
// both sizes in its zip64 extra field
function zip64Of(name, content) {
  const zip = zipOf({ [name]: content })
  const cdOffset = zip.readUInt32LE(zip.length - 22 + 16)
  const local = zip.subarray(0, cdOffset)
  const record = Buffer.from(zip.subarray(cdOffset, zip.length - 22))
  const nameLength = record.readUInt16LE(28)
  const compressed = record.readUInt32LE(20)
  const extra = Buffer.alloc(20)
  extra.writeUInt16LE(1, 0) // zip64 extra field id
  extra.writeUInt16LE(16, 2)
  // the zip64 field's order: uncompressed size, then compressed size
  extra.writeBigUInt64LE(BigInt(content.length), 4)
  extra.writeBigUInt64LE(BigInt(compressed), 12)
  const head = Buffer.from(record.subarray(0, 46 + nameLength))
  head.writeUInt32LE(0xffffffff, 20)
  head.writeUInt32LE(0xffffffff, 24)
  head.writeUInt16LE(extra.length, 30)
  head.writeUInt16LE(0, 32) // no comment
  const central = Buffer.concat([head, extra])
  const zip64End = Buffer.alloc(56)
  zip64End.writeUInt32LE(0x06064b50, 0)
  zip64End.writeBigUInt64LE(1n, 32) // total entries
  zip64End.writeBigUInt64LE(BigInt(central.length), 40)
  zip64End.writeBigUInt64LE(BigInt(local.length), 48) // directory offset
  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(0x07064b50, 0)
  locator.writeBigUInt64LE(BigInt(local.length + central.length), 8)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0xffff, 8)
  end.writeUInt16LE(0xffff, 10)
  end.writeUInt32LE(0xffffffff, 12)
  end.writeUInt32LE(0xffffffff, 16)
  return Buffer.concat([local, central, zip64End, locator, end])
}

// The entries of `files` reordered: `first` at the front, `last` at the end,
// both in the order given (names missing from `files` are skipped)
function reorder(files, { first = [], last = [] }) {
  const pick = (names) =>
    Object.fromEntries(
      names.filter((name) => files[name]).map((name) => [name, files[name]]),
    )
  const rest = { ...files }
  first.concat(last).forEach((name) => delete rest[name])
  return { ...pick(first), ...rest, ...pick(last) }
}

module.exports = {
  zipOf,
  rezip,
  incompressible,
  withDeclaredSize,
  zip64Of,
  reorder,
}
