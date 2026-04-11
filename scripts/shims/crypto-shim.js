// Browser-compatible crypto shim for esbuild browser builds.
// Provides randomBytes() via Web Crypto API, and createHash/createHmac
// via the create-hash/create-hmac packages (pure-JS browser implementations).

import {Buffer} from 'buffer';
import _createHash from 'create-hash';
import _createHmac from 'create-hmac';

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
  return _createHash(algorithm);
}

export function createHmac(algorithm, key) {
  return _createHmac(algorithm, key);
}

// Supported algorithms from the create-hash/create-hmac packages
export function getHashes() {
  return ['md5', 'ripemd160', 'rmd160', 'sha', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512'];
}

export default {randomBytes, createHash, createHmac, getHashes};
