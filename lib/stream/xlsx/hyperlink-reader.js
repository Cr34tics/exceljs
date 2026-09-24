const { EventEmitter } = require('events')
const parseSax = require('../../utils/parse-sax')

const Enums = require('../../doc/enums')
const RelType = require('../../xlsx/rel-type')

class HyperlinkReader extends EventEmitter {
  constructor({ workbook, id, iterator, options, entry }) {
    super()

    this.workbook = workbook
    this.id = id
    this.iterator = iterator
    this.options = options
    // the zip entry the iterator reads, when streamed by the workbook reader
    this.entry = entry
  }

  get count() {
    return (this.hyperlinks && this.hyperlinks.length) || 0
  }

  each(fn) {
    return this.hyperlinks.forEach(fn)
  }

  // Idempotent: the workbook reader's event API reads the hyperlinks itself
  // before moving on, and a listener may call read() too; both share one read
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
                      type: Enums.RelationshipType.Styles,
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
      if (this.listenerCount('error') > 0) {
        this.emit('error', error)
      } else if (!this.entry || error !== this.entry.errored) {
        // e.g. malformed XML: nobody else will report it
        throw error
      }
      // Otherwise the entry itself failed (a zip limit, a truncated archive):
      // the workbook reader reports that error, so don't raise it twice
    }
  }
}

module.exports = HyperlinkReader
