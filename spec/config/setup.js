const chai = require('chai');

const _dirtyChai = require('dirty-chai');
const chaiXml = require('./chai-xml-plugin');
const chaiDatetime = require('./chai-datetime-plugin');

const dirtyChai = _dirtyChai.default || _dirtyChai;
global.verquire = require('../utils/verquire');

global.expect = chai.expect;

chai.use(chaiXml);
chai.use(chaiDatetime);
chai.use(dirtyChai);
