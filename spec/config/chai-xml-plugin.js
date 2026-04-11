'use strict';

// Minimal inline replacement for the abandoned chai-xml package.
// Provides `.xml.to.equal()` and `.xml.to.be.valid()` assertions
// using sax for XML parsing (already a devDependency).
// Mirrors the xml2js-style comparison used by the original chai-xml:
// children are grouped by tag name into arrays, so element order
// within the same parent (for different tags) does not matter.

const sax = require('sax');

function parseXml(xmlStr) {
  const parser = sax.parser(true); // strict mode
  const stack = [];
  let root = null;
  let error = null;

  parser.onerror = function(e) {
    error = e;
  };

  parser.onopentag = function(node) {
    const elem = {$: {...node.attributes}, $$children: []};
    if (stack.length > 0) {
      stack[stack.length - 1].$$children.push({name: node.name, elem});
    }
    stack.push(elem);
  };

  parser.ontext = function(text) {
    if (stack.length > 0 && text.trim()) {
      const current = stack[stack.length - 1];
      if (!current._) current._ = '';
      current._ += text;
    }
  };

  parser.oncdata = function(cdata) {
    if (stack.length > 0) {
      const current = stack[stack.length - 1];
      if (!current._) current._ = '';
      current._ += cdata;
    }
  };

  parser.onclosetag = function(tagName) {
    const elem = stack.pop();
    // Convert $$children array into xml2js-style grouped object
    const grouped = {};
    for (const child of elem.$$children) {
      if (!grouped[child.name]) grouped[child.name] = [];
      grouped[child.name].push(child.elem);
    }
    delete elem.$$children;
    Object.assign(elem, grouped);

    // Remove empty $ (no attributes)
    if (Object.keys(elem.$).length === 0) {
      delete elem.$;
    }

    if (stack.length === 0) {
      root = {};
      root[tagName] = elem;
    }
  };

  parser.write(xmlStr).close();

  return {root, error};
}

module.exports = function chaiXmlPlugin(chai, utils) {
  const {flag} = utils;
  const {Assertion} = chai;

  Assertion.addProperty('xml', function() {
    new Assertion(this._obj).to.be.a('string');
    flag(this, 'xml', true);
  });

  Assertion.addMethod('valid', function() {
    new Assertion(flag(this, 'xml')).to.equal(true);
    const {error} = parseXml(this._obj);
    this.assert(
      error === null,
      'expected #{this} to be valid XML',
      'expected #{this} to not be valid XML',
      error
    );
  });

  const compareXml = function(_super) {
    return function assertEqual(value) {
      if (flag(this, 'xml')) {
        const negate = flag(this, 'negate');
        const actual = parseXml(this._obj);
        const expected = parseXml(value);

        new Assertion(actual.error).to.equal(null);
        new Assertion(expected.error).to.equal(null);

        if (negate) {
          new Assertion(actual.root).to.not.deep.equal(expected.root);
        } else {
          new Assertion(actual.root).to.deep.equal(expected.root);
        }
      } else {
        return _super.apply(this, arguments);
      }
    };
  };

  Assertion.overwriteMethod('equal', compareXml);
  Assertion.overwriteMethod('equals', compareXml);
  Assertion.overwriteMethod('eq', compareXml);
};
