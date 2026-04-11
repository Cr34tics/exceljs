/**
 * Copyright (c) 2014-2019 Guyon Roche
 * LICENCE: MIT - please refer to LICENSE file included with this module
 * or https://github.com/exceljs/exceljs/blob/master/LICENSE
 */

if (parseInt(process.versions.node.split('.')[0], 10) < 20) {
  throw new Error(
    'ExcelJS requires Node.js 20 or later. For older Node versions, please use the CJS import: https://github.com/exceljs/exceljs#es5-imports'
  );
}

module.exports = require('./lib/exceljs.nodejs.js');
