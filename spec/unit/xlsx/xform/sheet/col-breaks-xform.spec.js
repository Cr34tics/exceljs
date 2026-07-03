const testXformHelper = require('../test-xform-helper')

const ColBreaksXform = verquire('xlsx/xform/sheet/col-breaks-xform')

const expectations = [
  {
    title: 'one column break',
    create() {
      return new ColBreaksXform()
    },
    preparedModel: [{ id: 3, max: 1048575, man: 1 }],
    xml:
      '<colBreaks count="1" manualBreakCount="1">' +
      '<brk id="3" max="1048575" man="1"/>' +
      '</colBreaks>',
    parsedModel: [{ id: 3, max: 1048575, man: 1 }],
    tests: ['render', 'parse'],
  },
  {
    title: 'multiple column breaks with min',
    create() {
      return new ColBreaksXform()
    },
    preparedModel: [
      { id: 3, max: 1048575, man: 1, min: 2 },
      { id: 6, max: 1048575, man: 1 },
    ],
    xml:
      '<colBreaks count="2" manualBreakCount="2">' +
      '<brk id="3" max="1048575" man="1" min="2"/>' +
      '<brk id="6" max="1048575" man="1"/>' +
      '</colBreaks>',
    parsedModel: [
      { id: 3, max: 1048575, man: 1, min: 2 },
      { id: 6, max: 1048575, man: 1 },
    ],
    tests: ['render', 'parse'],
  },
]

describe('ColBreaksXform', () => {
  testXformHelper(expectations)
})
