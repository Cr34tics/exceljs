// Minimal process shim for browser builds
// Provides process.browser, process.nextTick, and process.env
export const process = {
  browser: true,
  env: {},
  nextTick: function(fn) {
    Promise.resolve().then(fn);
  },
};
