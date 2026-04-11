'use strict';

// Minimal inline replacement for the abandoned chai-datetime package.
// Only the assertions actually used in this project are implemented.

module.exports = function chaiDatetimePlugin(chai) {
  const {Assertion} = chai;

  function formatDate(date) {
    return date.toDateString();
  }

  Assertion.addChainableMethod('equalDate', function(expected) {
    const actualFormatted = formatDate(this._obj);
    const expectedFormatted = formatDate(expected);

    this.assert(
      this._obj.toDateString() === expected.toDateString(),
      `expected ${actualFormatted} to equal ${expectedFormatted}`,
      `expected ${actualFormatted} to not equal ${expectedFormatted}`,
      expectedFormatted,
      actualFormatted
    );
  });
};
