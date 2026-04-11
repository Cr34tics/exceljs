const chai = require('chai');

const chaiXml = require('chai-xml');
const chaiDatetime = require('chai-datetime');
const _dirtyChai = require('dirty-chai');
const dirtyChai = _dirtyChai.default || _dirtyChai;
global.verquire = require('../utils/verquire');

global.expect = chai.expect;

chai.use(chaiXml);
chai.use(chaiDatetime);
chai.use(dirtyChai);
