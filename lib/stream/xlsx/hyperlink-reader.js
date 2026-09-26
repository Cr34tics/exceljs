const { EventEmitter } = require('events')
const parseSax = require('../../utils/parse-sax')
const utils = require('../../utils/utils')

const Enums = require('../../doc/enums')
const RelType = require('../../xlsx/rel-type')

class HyperlinkReader extends EventEmitter {
  constructor({ workbook, id, iterator, options }) {
    super()

    this.workbook = workbook
    this.id = id
    this.iterator = iterator
    this.options = options
  }

  // with hyperlinks: 'cache', read() collects them keyed by relationship id
  get count() {
    return this.hyperlinks ? Object.keys(this.hyperlinks).length : 0
  }

  each(fn) {
    return Object.values(this.hyperlinks || {}).forEach(fn)
  }

  // Idempotent: the workbook reader reads the hyperlinks itself before moving
  // on, and a consumer may call read() too, then or later; all share one read
  read() {
    if (!this._reading) {
      this._reading = this._read()
    }
    return this._reading
  }

  async _read() {
    const { iterator, options } = this
    let emitHyperlinks = false
    let hyperlinks = null
    switch (options.hyperlinks) {
      case 'emit':
        emitHyperlinks = true
        break
      case 'cache':
        this.hyperlinks = hyperlinks = {}
        break
      default:
        break
    }

    if (!emitHyperlinks && !hyperlinks) {
      this.emit('finished')
      return
    }

    try {
      for await (const events of parseSax(iterator)) {
        for (const { eventType, value } of events) {
          if (eventType === 'opentag') {
            const node = value
            if (node.name === 'Relationship') {
              const rId = node.attributes.Id
              switch (node.attributes.Type) {
                case RelType.Hyperlink:
                  {
                    const relationship = {
                      type: Enums.RelationshipType.Hyperlink,
                      rId,
                      target: node.attributes.Target,
                      targetMode: node.attributes.TargetMode,
                    }
                    if (emitHyperlinks) {
                      this.emit('hyperlink', relationship)
                    } else {
                      hyperlinks[relationship.rId] = relationship
                    }
                  }
                  break

                default:
                  break
              }
            }
          }
        }
      }
      this.emit('finished')
    } catch (error) {
      // The workbook reader awaits this same promise, so a caller that doesn't
      // await its own read() gets no unhandled rejection
      utils.rethrowToListeners(this, error)
    }
  }
}

module.exports = HyperlinkReader
