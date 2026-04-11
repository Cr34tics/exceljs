// Minimal process shim for browser builds
// Provides process.browser, process.nextTick, and process.env
// Used both as an esbuild inject (for global process references) and
// as a module (for require('process') in readable-stream, etc.)
export const browser = true;
export const env = {};
export function nextTick(fn, ...args) {
  Promise.resolve().then(() => fn(...args));
}
export const version = '';
export const versions = {};
export const stdout = null;
export const stderr = null;

export const process = {
  browser,
  env,
  nextTick,
  version,
  versions,
  stdout,
  stderr,
};

export default process;
