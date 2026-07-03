const BaseXform = require('../base-xform')

class PageBreaksXform extends BaseXform {
  get tag() {
    return 'brk'
  }

  render(xmlStream, model) {
    xmlStream.leafNode('brk', model)
  }

  parseOpen(node) {
    if (node.name === 'brk') {
      const { id, min, max, man } = node.attributes
      this.model = {}
      if (id !== undefined) this.model.id = parseInt(id, 10)
      if (min !== undefined) this.model.min = parseInt(min, 10)
      if (max !== undefined) this.model.max = parseInt(max, 10)
      if (man !== undefined) this.model.man = parseInt(man, 10)
      return true
    }
    return false
  }

  parseText() {}

  parseClose() {
    return false
  }
}

module.exports = PageBreaksXform
