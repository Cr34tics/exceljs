const { EventEmitter } = require('events')
const utils = require('../../utils/utils')
const { CONSUMED } = require('../../utils/iterate-stream')

// Base of the readers WorkbookReader hands out for a streamed part (a
// worksheet, a worksheet's hyperlinks). The part's zip entry can be read only
// once, and only until the workbook reader moves on from it.
class PartReader extends EventEmitter {
  constructor({ workbook, id, iterator, options }) {
    super()

    this.workbook = workbook
    this.id = id
    this.iterator = iterator
    this.options = options || {}
  }

  // Reads the part, emitting its events, then 'finished'. Later calls share
  // the first read (a subclass may also let other ways of reading the part
  // settle it: see WorksheetReader#parse). A read() runs by itself
  // (_selfRead), so the workbook reader always lets it finish.
  read() {
    if (!this._reading) {
      this._reading = this._selfRead = this._read()
    }
    return this._reading
  }

  async _read() {
    try {
      await this._readPart()
      this.emit('finished')
    } catch (error) {
      this._rethrowToListeners(this._partError(error))
    }
  }

  // Called by the workbook reader when it closes the part's entry before the
  // part was read to its end: its consumer stopped reading, or the workbook
  // reader stopped
  _abandon() {
    this._abandoned = true
  }

  // The error to report for `error`, raised reading the part: if it only
  // says the workbook reader closed the entry, say the part was cut off
  _partError(error) {
    return this._abandoned && error.code === 'ERR_STREAM_PREMATURE_CLOSE'
      ? new Error(CONSUMED)
      : error
  }

  // Reports a read's error to the 'error' listeners, if there are any
  // (emitting 'error' with none would throw), and always rethrows it: a
  // listener mustn't turn a corrupt part into a successful workbook read.
  // Once a listener has it, the shared read is marked handled: whoever awaits
  // it still sees the error, but a read() nobody awaits doesn't also reject
  // unhandled.
  _rethrowToListeners(error) {
    if (this.listenerCount('error') > 0) {
      this.emit('error', error)
      if (this._reading) this._reading.catch(utils.nop)
    }
    throw error
  }
}

module.exports = PartReader
