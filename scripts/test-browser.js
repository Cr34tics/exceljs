'use strict';

// Browser-bundle tests using Playwright: validates that the built dist/exceljs.js
// bundle works correctly in a real headless browser environment.
// This replaces the former grunt-contrib-jasmine browser tests and the Node VM-based
// smoke tests, providing genuine browser coverage.

const {chromium} = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');

const bundlePath = path.resolve(__dirname, '..', 'dist', 'exceljs.js');
const minBundlePath = path.resolve(__dirname, '..', 'dist', 'exceljs.min.js');
const bareBundlePath = path.resolve(__dirname, '..', 'dist', 'exceljs.bare.js');

// Serve a minimal HTML page that loads the ExcelJS bundle
function createServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end(`<!DOCTYPE html>
<html><head><title>ExcelJS Browser Test</title></head>
<body><script src="/exceljs.js"></script></body></html>`);
      } else if (req.url === '/exceljs.js') {
        res.writeHead(200, {'Content-Type': 'application/javascript'});
        fs.createReadStream(bundlePath).pipe(res);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
    server.on('error', reject);
  });
}

async function runTests() {
  let passed = 0;
  let failed = 0;

  function report(name, ok, err) {
    if (ok) {
      console.log(`  ✔ ${name}`);
      passed++;
    } else {
      console.error(`  ✘ ${name}`);
      if (err) console.error(`    ${err}`);
      failed++;
    }
  }

  console.log('Browser bundle tests:');

  // Static file existence checks
  report('dist/exceljs.js should exist', fs.existsSync(bundlePath));
  report('dist/exceljs.min.js should exist', fs.existsSync(minBundlePath));
  report('dist/exceljs.bare.js should exist', fs.existsSync(bareBundlePath));

  // Launch browser and run actual ExcelJS operations
  const server = await createServer();
  const port = server.address().port;
  const browser = await chromium.launch();

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Collect console errors from the browser
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => consoleErrors.push(err.message));

    await page.goto(`http://127.0.0.1:${port}/`);

    // Test: bundle loads without errors and defines ExcelJS global
    try {
      const hasExcelJS = await page.evaluate(() => typeof window.ExcelJS === 'object' && window.ExcelJS !== null);
      report('bundle should define ExcelJS global', hasExcelJS, !hasExcelJS && 'ExcelJS is not defined');
    } catch (err) {
      report('bundle should define ExcelJS global', false, err.message);
    }

    // Test: ExcelJS.Workbook is a constructor
    try {
      const hasWorkbook = await page.evaluate(() => typeof window.ExcelJS.Workbook === 'function');
      report('ExcelJS.Workbook should be a constructor', hasWorkbook);
    } catch (err) {
      report('ExcelJS.Workbook should be a constructor', false, err.message);
    }

    // Test: ExcelJS exposes ValueType and FormulaType enums
    try {
      const hasEnums = await page.evaluate(() =>
        window.ExcelJS.ValueType !== undefined && window.ExcelJS.FormulaType !== undefined
      );
      report('bundle should expose ValueType and FormulaType enums', hasEnums);
    } catch (err) {
      report('bundle should expose ValueType and FormulaType enums', false, err.message);
    }

    // Test: read and write xlsx via binary buffer
    try {
      const result = await page.evaluate(async () => {
        const wb = new window.ExcelJS.Workbook();
        const ws = wb.addWorksheet('blort');
        ws.getCell('A1').value = 'Hello, World!';
        ws.getCell('A2').value = 7;

        const buffer = await wb.xlsx.writeBuffer();
        const wb2 = new window.ExcelJS.Workbook();
        await wb2.xlsx.load(buffer);
        const ws2 = wb2.getWorksheet('blort');

        return {
          a1: ws2.getCell('A1').value,
          a2: ws2.getCell('A2').value,
        };
      });
      const ok = result.a1 === 'Hello, World!' && result.a2 === 7;
      report('should read and write xlsx via binary buffer', ok,
        !ok && `A1=${result.a1}, A2=${result.a2}`);
    } catch (err) {
      report('should read and write xlsx via binary buffer', false, err.message);
    }

    // Test: read and write xlsx via base64 buffer
    try {
      const result = await page.evaluate(async () => {
        const options = {base64: true};
        const wb = new window.ExcelJS.Workbook();
        const ws = wb.addWorksheet('blort');
        ws.getCell('A1').value = 'Hello, World!';
        ws.getCell('A2').value = 7;

        const buffer = await wb.xlsx.writeBuffer(options);
        const wb2 = new window.ExcelJS.Workbook();
        // Convert ArrayBuffer to base64 string for load
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64String = btoa(binary);
        await wb2.xlsx.load(base64String, options);
        const ws2 = wb2.getWorksheet('blort');

        return {
          a1: ws2.getCell('A1').value,
          a2: ws2.getCell('A2').value,
        };
      });
      const ok = result.a1 === 'Hello, World!' && result.a2 === 7;
      report('should read and write xlsx via base64 buffer', ok,
        !ok && `A1=${result.a1}, A2=${result.a2}`);
    } catch (err) {
      report('should read and write xlsx via base64 buffer', false, err.message);
    }

    // Test: write csv via buffer
    try {
      const csvContent = await page.evaluate(async () => {
        const wb = new window.ExcelJS.Workbook();
        const ws = wb.addWorksheet('blort');
        ws.getCell('A1').value = 'Hello, World!';
        ws.getCell('B1').value = 'What time is it?';
        ws.getCell('A2').value = 7;
        ws.getCell('B2').value = '12pm';

        const buffer = await wb.csv.writeBuffer();
        // Convert buffer to string
        const decoder = new TextDecoder();
        return decoder.decode(buffer);
      });
      // CSV standard: values containing commas are quoted, others are not
      const expected = '"Hello, World!",What time is it?\n7,12pm';
      const ok = csvContent === expected;
      report('should write csv via buffer', ok,
        !ok && `Expected: ${JSON.stringify(expected)}, Got: ${JSON.stringify(csvContent)}`);
    } catch (err) {
      report('should write csv via buffer', false, err.message);
    }

    // Report any unexpected console errors
    if (consoleErrors.length > 0) {
      console.warn(`\n  ⚠ Browser console errors:\n    ${consoleErrors.join('\n    ')}`);
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n${passed + failed} tests: ${passed} passing, ${failed} failing`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
