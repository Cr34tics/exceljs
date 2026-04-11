// Browser-compatible crypto shim for esbuild browser builds.
// Implements randomBytes() using the Web Crypto API when available.

function getGlobalScope() {
  if (typeof globalThis !== 'undefined') {
    return globalThis;
  }
  if (typeof self !== 'undefined') {
    return self;
  }
  if (typeof window !== 'undefined') {
    return window;
  }
  return undefined;
}

function getWebCrypto() {
  const scope = getGlobalScope();
  const cryptoObj = scope && scope.crypto;

  if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
    throw new Error(
      'crypto.randomBytes requires Web Crypto API (crypto.getRandomValues); ' +
        'ensure a secure context (HTTPS) or a compatible browser'
    );
  }

  return cryptoObj;
}

export function randomBytes(size) {
  const buf = new Uint8Array(size);
  getWebCrypto().getRandomValues(buf);
  return Buffer.from(buf);
}

export function createHash(algorithm) {
  throw new Error(
    `crypto.createHash("${algorithm || ''}") is not supported in browser builds. ` +
      'Features requiring hashing (e.g. worksheet protection) need Node.js ' +
      'or a browser-compatible crypto polyfill.'
  );
}

export function createHmac(algorithm) {
  throw new Error(
    `crypto.createHmac("${algorithm || ''}") is not supported in browser builds. ` +
      'Features requiring HMAC need Node.js or a browser-compatible crypto polyfill.'
  );
}

export default {randomBytes, createHash, createHmac};
