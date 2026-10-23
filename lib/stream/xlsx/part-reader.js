const { EventEmitter } = require('events')
const utils = require('../../utils/utils')

// Base of the readers WorkbookReader hands out for a streamed part (a
// worksheet, a worksheet's hyperlinks). The part's zip entry can be read only
// once, and only until the workbook reader moves on from it.
class PartReader extends EventEmitter {
  constructor({ id, iterator }) {
    super()

    this.id = id
    this.iterator = iterator
  }

  // Reads the part, emitting its events, then 'finished'. Later calls share
  // the first read. A read() runs by itself, so the workbook reader always
  // lets it finish.
  read() {
    if (!this._reading) {
      this._reading = this._read()
    }
    return this._reading
  }

  async _read() {
    try {
      await this._readPart()
      this.emit('finished')
    } catch (error) {
      // Reported to the 'error' listeners, if there are any (emitting 'error'
      // with none would throw), and always rethrown: a listener mustn't turn
      // a corrupt part into a successful workbook read. Once a listener has
      // it, the read is marked handled: whoever awaits it still sees the
      // error, but a read() nobody awaits doesn't also reject unhandled.
      if (this.listenerCount('error') > 0) {
        this.emit('error', error)
        this._reading.catch(utils.nop)
      }
      throw error
    } finally {
      this._settled = true
      // set by the workbook reader to clean up after a read it stopped
      // waiting for, without handling the read's rejection itself
      if (this._afterRead) this._afterRead()
    }
  }
}

module.exports = PartReader
