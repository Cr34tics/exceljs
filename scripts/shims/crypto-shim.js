// Browser-compatible crypto shim for esbuild browser builds.
// Implements randomBytes() using the Web Crypto API (globalThis.crypto.getRandomValues).

export function randomBytes(size) {
  const buf = new Uint8Array(size);
  globalThis.crypto.getRandomValues(buf);
  return Buffer.from(buf);
}

export function createHash() {
  throw new Error('crypto.createHash is not supported in browser builds');
}

export function createHmac() {
  throw new Error('crypto.createHmac is not supported in browser builds');
}

export default {randomBytes, createHash, createHmac};
