/**
 * Copyright (c) 2014-2019 Guyon Roche
 * LICENCE: MIT - please refer to LICENSE file included with this module
 * or https://github.com/exceljs/exceljs/blob/master/LICENSE
 */

if (parseInt(process.versions.node.split('.')[0], 10) < 20) {
  throw new Error(
    'ExcelJS requires Node.js 20 or later. Please upgrade Node.js or use an older ExcelJS release that supports your Node version.'
  );
}

module.exports = require('./lib/exceljs.nodejs.js');
