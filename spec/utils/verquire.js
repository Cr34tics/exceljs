// this module allows the specs to switch between source code and
// built code depending on the environment variable EXCEL_BUILD

/* eslint-disable import/no-dynamic-require */

const libs = {};
const basePath = (function() {
  if (process.env.EXCEL_BUILD === 'cjs') {
    libs.exceljs = require('../../dist/cjs');
    return '../../dist/cjs/';
  }
  libs.exceljs = require('../../lib/exceljs.nodejs');
  return '../../lib/';
})();

module.exports = function verquire(path) {
  if (!libs[path]) {
    libs[path] = require(basePath + path);
  }
  return libs[path];
};
