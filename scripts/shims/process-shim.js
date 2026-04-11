// Minimal process shim for browser builds
// Provides process.browser, process.nextTick, and process.env
// Used both as an esbuild inject (for global process references) and
// as a module (for require('process') in readable-stream, etc.)
export const process = {
  browser: true,
  env: {},
  nextTick: function(fn, ...args) {
    Promise.resolve().then(() => fn(...args));
  },
  version: '',
  versions: {},
  stdout: null,
  stderr: null,
};

export default process;
