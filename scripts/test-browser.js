'use strict';

// Browser-bundle smoke test: validates that the built dist/exceljs.js
// bundle can be loaded, has the correct API surface, and is valid JS.
// This replaces the former grunt-contrib-jasmine browser tests.
//
// Full browser-context testing (XLSX read/write via the bundled polyfills)
// requires a real browser environment. This script validates the bundle
// integrity and API shape in Node.js.

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const bundlePath = path.resolve(__dirname, '..', 'dist', 'exceljs.js');
const minBundlePath = path.resolve(__dirname, '..', 'dist', 'exceljs.min.js');
const bareBundlePath = path.resolve(__dirname, '..', 'dist', 'exceljs.bare.js');

async function runTests() {
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✔ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✘ ${name}`);
      console.error(`    ${err.message}`);
      failed++;
    }
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed');
  }

  console.log('Browser bundle tests:');

  test('dist/exceljs.js should exist', () => {
    assert(fs.existsSync(bundlePath), 'dist/exceljs.js should exist');
  });

  test('dist/exceljs.min.js should exist', () => {
    assert(fs.existsSync(minBundlePath), 'dist/exceljs.min.js should exist');
  });

  test('dist/exceljs.bare.js should exist', () => {
    assert(fs.existsSync(bareBundlePath), 'dist/exceljs.bare.js should exist');
  });

  test('bundle should be valid JavaScript', () => {
    const code = fs.readFileSync(bundlePath, 'utf-8');
    // This will throw a SyntaxError if the JS is invalid
    new vm.Script(code);
  });

  test('minified bundle should be valid JavaScript', () => {
    const code = fs.readFileSync(minBundlePath, 'utf-8');
    new vm.Script(code);
  });

  test('bundle should define ExcelJS global with Workbook constructor', () => {
    const code = fs.readFileSync(bundlePath, 'utf-8');
    const sandbox = {
      module: {exports: {}},
      exports: {},
      require,
      Buffer,
      process,
      console,
      setTimeout,
      setInterval,
      clearTimeout,
      clearInterval,
      setImmediate,
      queueMicrotask,
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    assert(sandbox.ExcelJS, 'ExcelJS should be defined as a global');
    assert(typeof sandbox.ExcelJS.Workbook === 'function', 'ExcelJS.Workbook should be a constructor');
  });

  test('bundle should expose ValueType and FormulaType enums', () => {
    const code = fs.readFileSync(bundlePath, 'utf-8');
    const sandbox = {
      module: {exports: {}},
      exports: {},
      require,
      Buffer,
      process,
      console,
      setTimeout,
      setInterval,
      clearTimeout,
      clearInterval,
      setImmediate,
      queueMicrotask,
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    assert(sandbox.ExcelJS.ValueType, 'ExcelJS.ValueType should be defined');
    assert(sandbox.ExcelJS.FormulaType, 'ExcelJS.FormulaType should be defined');
  });

  test('bundle should set module.exports for CommonJS compatibility', () => {
    const code = fs.readFileSync(bundlePath, 'utf-8');
    const sandbox = {
      module: {exports: {}},
      exports: {},
      require,
      Buffer,
      process,
      console,
      setTimeout,
      setInterval,
      clearTimeout,
      clearInterval,
      setImmediate,
      queueMicrotask,
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    assert(
      typeof sandbox.module.exports.Workbook === 'function',
      'module.exports.Workbook should be a constructor'
    );
  });

  console.log(`\n${passed + failed} tests: ${passed} passing, ${failed} failing`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
