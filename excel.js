/**
 * Copyright (c) 2014-2019 Guyon Roche
 * LICENCE: MIT - please refer to LICENSE file included with this module
 * or https://github.com/exceljs/exceljs/blob/master/LICENSE
 */

// archiver@8 is ESM-only and is loaded via require(); synchronous require() of an
// ES module is only enabled by default on Node.js >= 22.12.0 (and >= 20.19.0).
// Guard on 22.12.0 so unsupported runtimes get a clear message instead of a
// cryptic ERR_REQUIRE_ESM thrown from deep inside archiver.
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 12)) {
  throw new Error(
    'ExcelJS requires Node.js 22.12.0 or later. Please upgrade Node.js or use an older ExcelJS release that supports your Node version.',
  )
}

module.exports = require('./lib/exceljs.nodejs.js')
