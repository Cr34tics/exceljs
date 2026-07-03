// Browser-compatible crypto shim for esbuild browser builds.
// Provides randomBytes() via the Web Crypto API, and createHash() via the
// zero-dependency, audited @noble/hashes package (synchronous SHA-2).
// The Node build uses the real `crypto` module and never loads this shim.

import { Buffer } from 'buffer'
import { sha224, sha256, sha384, sha512 } from '@noble/hashes/sha2.js'

// Only the SHA-2 family is wired up. ExcelJS itself only ever requests SHA-512
// (OOXML worksheet-protection password hashing); the rest are provided for
// completeness. Legacy md5/ripemd160 are intentionally omitted — nothing uses them.
const ALGORITHMS = { sha224, sha256, sha384, sha512 }

function getGlobalScope() {
  if (typeof globalThis !== 'undefined') {
    return globalThis
  }
  if (typeof self !== 'undefined') {
    return self
  }
  if (typeof window !== 'undefined') {
    return window
  }
  return undefined
}

function getWebCrypto() {
  const scope = getGlobalScope()
  const cryptoObj = scope && scope.crypto

  if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
    throw new Error(
      'crypto.randomBytes requires Web Crypto API (crypto.getRandomValues); ' +
        'ensure a secure context (HTTPS) or a compatible browser',
    )
  }

  return cryptoObj
}

export function randomBytes(size) {
  const buf = new Uint8Array(size)
  getWebCrypto().getRandomValues(buf)
  return Buffer.from(buf)
}

// Mirrors Node's crypto.createHash(algorithm).update(data).digest() streaming
// interface used by lib/utils/encryptor.js.
export function createHash(algorithm) {
  const algo = ALGORITHMS[String(algorithm).toLowerCase()]
  if (!algo) {
    throw new Error(`Hash algorithm '${algorithm}' not supported!`)
  }
  const hasher = algo.create()
  return {
    update(data) {
      // Buffer is a Uint8Array subclass, so it is accepted directly
      hasher.update(data)
      return this
    },
    digest() {
      // Uint8Array -> Buffer so callers can .toString('base64') etc.
      return Buffer.from(hasher.digest())
    },
  }
}

// Supported algorithms, used by encryptor.js to validate the requested algorithm
export function getHashes() {
  return Object.keys(ALGORITHMS)
}

export default { randomBytes, createHash, getHashes }
