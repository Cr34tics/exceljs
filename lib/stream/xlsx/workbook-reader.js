const fs = require('fs')
const { EventEmitter, on } = require('events')
const { PassThrough, Readable, finished: eos } = require('stream')
const { finished } = require('stream/promises')
// captured now, so fake timers installed later can't stall the read
const { setImmediate: nextMacrotask } = require('timers/promises')
const unzip = require('unzipper')
const _ = require('../../utils/under-dash')
const utils = require('../../utils/utils')
const iterateStream = require('../../utils/iterate-stream')

const { checkOpen, CONSUMED } = iterateStream
const parseSax = require('../../utils/parse-sax')
const ZipLimits = require('../../utils/zip-limits')

const StyleManager = require('../../xlsx/xform/style/styles-xform')
const WorkbookXform = require('../../xlsx/xform/book/workbook-xform')
const RelationshipsXform = require('../../xlsx/xform/core/relationships-xform')

const WorksheetReader = require('./worksheet-reader')
const HyperlinkReader = require('./hyperlink-reader')

// The worksheets and their hyperlinks (relationships) parts
const SHEET = /xl\/worksheets\/sheet(\d+)[.]xml/
const SHEET_RELS = /xl\/worksheets\/_rels\/sheet(\d+)[.]xml[.]rels/

// Entries unzipper may parse ahead of the read loop before the input is held
// back (see parse())
const MAX_QUEUED_ENTRIES = 16

// `options` over `base`, except where undefined
function mergeOptions(base, options) {
  return _.deepMerge({}, base, options)
}

// Drains the rest of a zip entry (unzipper's) and settles on its end or
// error. A consumer that stopped reading its part halfway, or never read it,
// is cut off: reading the part then fails with "Stream was already consumed".
async function drainEntry(raw) {
  const { part } = raw
  // unzipper drains an entry nothing reads by itself
  if (!part) return
  if (!part.readableEnded) {
    raw.unpipe(part)
    part.destroy(new Error(CONSUMED))
  }
  await finished(raw.resume())
}

class WorkbookReader extends EventEmitter {
  constructor(input, options) {
    super()

    this.input = input
    this.options = mergeOptions(
      {
        worksheets: 'emit',
        sharedStrings: 'cache',
        hyperlinks: 'ignore',
        styles: 'ignore',
        entries: 'ignore',
      },
      options,
    )
    // the zip limits of a read()/parse() given options fall back to these
    this._constructorOptions = this.options
    // fail fast on an invalid limit
    new ZipLimits(this.options, ZipLimits.STREAMING_DEFAULTS)
    this._resetArchiveState()
  }

  // What the reader learns of the archive it reads. Each read starts afresh:
  // nothing learnt of a previous archive may leak into the next.
  _resetArchiveState() {
    this.workbookRels = undefined
    // Filled from xl/workbook.xml; empty if an archive lacks it, so readers of
    // them don't crash
    this.model = {}
    this.properties = {}
    // set once xl/sharedStrings.xml is read, with sharedStrings: 'cache'
    this.sharedStrings = undefined
    this.styles = new StyleManager()
    this.styles.init()
    this.stylesRead = false
  }

  _getStream(input) {
    if (typeof input === 'string') {
      return fs.createReadStream(input)
    }
    if (
      typeof input === 'object' &&
      input !== null &&
      typeof input.pipe === 'function' &&
      typeof input.on === 'function'
    ) {
      return input
    }
    throw new Error(`Could not recognise input: ${input}`)
  }

  async read(input, options) {
    try {
      for await (const { eventType, value } of this.parse(input, options)) {
        switch (eventType) {
          case 'shared-strings':
            this.emit(eventType, value)
            break
          case 'worksheet':
            // read() reads each worksheet itself, emitting its rows: a
            // listener can't iterate it (see WorksheetReader#parse)
            value._readByEvents = true
            this.emit(eventType, value)
            await value.read()
            break
          case 'hyperlinks':
            this.emit(eventType, value)
            break
        }
      }
      this.emit('end')
      this.emit('finished')
    } catch (error) {
      this.emit('error', error)
    }
  }

  async *[Symbol.asyncIterator]() {
    for await (const { eventType, value } of this.parse()) {
      if (eventType === 'worksheet') {
        yield value
      }
    }
  }

  async *parse(input, options) {
    // A limit `options` sets applies to this call; any other comes from the
    // constructor (checked before the options are taken on)
    const limits = new ZipLimits(
      mergeOptions(this._constructorOptions, options),
      ZipLimits.STREAMING_DEFAULTS,
    )
    // Options that set only limits leave the reader's options as they are.
    // Any other `options` replace them, as they always have (callers rely on
    // it, e.g. to leave shared strings unset).
    const limitsOnly =
      options &&
      Object.keys(options).every((name) => name in ZipLimits.STREAMING_DEFAULTS)
    if (options && !limitsOnly) {
      this.options = options
    }
    this._resetArchiveState()
    input = input || this.input
    // a stream we open ourselves is ours to close
    const ownsStream = typeof input === 'string'
    const stream = (this.stream = this._getStream(input))
    // Piping a stream that failed or closed would leave the zip parser
    // waiting forever
    checkOpen(stream, 'Could not read input: the stream has failed or closed')
    const zip = unzip.Parse()
    // An input that fails, or closes before its end (e.g. a cancelled
    // upload), fails the zip parser, which would otherwise hang or crash the
    // process: pipe() passes on neither
    const stopWatchingInput = eos(stream, { writable: false }, (error) => {
      if (error) zip.destroy(error)
    })
    // Drop the empty chunks an object-mode input can push: unzipper never
    // finishes writing one, which would hang the read
    const write = zip.write.bind(zip)
    zip.write = (chunk, ...rest) =>
      chunk && chunk.length === 0 ? true : write(chunk, ...rest)
    stream.pipe(zip)
    // unzipper hands entries out as 'entry' events, pushing nothing on its
    // readable side, and ends that side at the end of central directory
    // record. Flowing, it then emits 'end', which ends the loop below, also
    // when bytes trail the record. (It emits 'end' itself too when the input
    // ends, wherever that is: see the check after the loop.)
    zip.resume()

    // unzipper parses on to the next entry as soon as it has buffered one,
    // without waiting for it to be read, so the limits are checked as it
    // parses each entry rather than when this loop gets to it: otherwise an
    // archive of many small entries would be buffered whole first. A limit
    // hit stops the parser.
    // Each entry (`raw`, unzipper's) is piped into the part its parser reads,
    // so the entry can still be drained if a consumer stops reading the part
    // halfway.
    // the entry unzipper is writing: only the latest can be unfinished
    let lastEntry
    // unzipper doesn't wait for this loop either: once entries are queued
    // for it, hold the input back until the loop catches up, so a slow
    // consumer doesn't let small entries pile up in memory
    let queued = 0
    let heldBack = false
    // a legacy (pre-streams2) stream has no unpipe()
    const canHoldBack = typeof stream.unpipe === 'function'
    // Stops the parser with `error`, failing the entry it was still writing
    // too (see the 'error' listener below)
    const failArchive = (error) => {
      if (lastEntry && !lastEntry.writableFinished) {
        lastEntry.destroy(error)
      }
      zip.destroy(error)
    }
    const onEntry = (raw) => {
      lastEntry = raw
      // Its errors reach its part (below) and the loop's drain of it; this
      // stops failArchive() failing an entry nothing listens to yet from
      // being an uncaught 'error'
      raw.on('error', utils.nop)
      queued += 1
      if (canHoldBack && !heldBack && queued >= MAX_QUEUED_ENTRIES) {
        heldBack = true
        stream.unpipe(zip)
      }
      try {
        limits.addEntry()
      } catch (error) {
        failArchive(error)
        return
      }
      if (!this._readsPart(raw.path)) {
        // unzipper then skips inflating it: what isn't inflated can't be a
        // bomb, so only the entries it does inflate count towards the limit
        raw.drained = true
        raw.autodrain()
        return
      }
      const part = new PassThrough()
      // Its errors reach its reader's iterator, and the loop's drain of the
      // entry, not an 'error' event: once neither listens (it was read, or
      // the read stopped) there is nobody to tell
      part.on('error', utils.nop)
      // a failed or cut-off entry fails its part too
      eos(raw, (error) => {
        if (error) part.destroy(error)
      })
      // counted with the limit disabled too, which can't trip it: one path
      raw.on('data', (chunk) => {
        try {
          limits.addBytes(chunk.length)
        } catch (error) {
          // it may have been written whole, with this data still queued
          raw.destroy(error)
          failArchive(error)
        }
      })
      raw.pipe(part)
      raw.part = part
    }
    zip.on('entry', onEntry)

    // unzipper reports a truncated or corrupt archive on the zip stream only,
    // leaving an entry it was still writing open forever: fail that entry
    // too, so whatever reads or drains it settles (it may still be queued
    // for this loop, which gets queued entries before the error), and stop
    // the parser
    zip.on('error', failArchive)

    let currentEntry
    // the reader handed out for the current entry, if any
    let currentReader
    let failed = false

    // worksheets, deferred for parsing after shared strings reading
    const waitingWorkSheets = []

    try {
      for await (const [raw] of on(zip, 'entry', { close: ['end'] })) {
        currentEntry = raw
        currentReader = undefined
        queued -= 1
        if (heldBack && queued < MAX_QUEUED_ENTRIES / 2) {
          heldBack = false
          stream.pipe(zip)
        }
        // what the entry's parser reads, its bytes counted as they arrive
        // (see onEntry); a part nothing reads (media etc.) is drained
        // without being inflated
        const { part } = raw
        // the entry that hit a limit still arrives, before the parser's error
        if (!part && !raw.drained) throw zip.errored
        switch (raw.path) {
          case 'xl/_rels/workbook.xml.rels':
            await this._parseRels(part)
            break
          case 'xl/workbook.xml':
            await this._parseWorkbook(part)
            break
          case 'xl/sharedStrings.xml':
            yield* this._parseSharedStrings(part)
            break
          case 'xl/styles.xml':
            await this._parseStyles(part)
            break
          default: {
            let match = raw.path.match(SHEET)
            if (match) {
              const sheetNo = match[1]
              if (this.options.worksheets !== 'emit') {
                // nothing reads it: it is only drained
                this._emitEntry({ type: 'worksheet', id: sheetNo })
              } else if (this._canStreamWorksheet()) {
                const worksheetReader = this._createWorksheetReader(
                  iterateStream(part),
                  sheetNo,
                )
                currentReader = worksheetReader
                yield { eventType: 'worksheet', value: worksheetReader }
                // A read() of it runs by itself: let it finish. A consumer
                // iterating it is done with it once this loop moves on.
                await worksheetReader._selfRead
              } else {
                // buffer worksheet data in memory for deferred parsing
                const chunks = await part.toArray()
                waitingWorkSheets.push({ sheetNo, chunks })
              }
              break
            }
            match = raw.path.match(SHEET_RELS)
            if (match) {
              const sheetNo = match[1]
              this._emitEntry({ type: 'hyperlinks', id: sheetNo })
              // Only 'emit' hands them out; nothing reads them otherwise
              if (this.options.hyperlinks === 'emit') {
                const hyperlinksReader = new HyperlinkReader({
                  workbook: this,
                  id: sheetNo,
                  iterator: iterateStream(part),
                  options: this.options,
                })
                currentReader = hyperlinksReader
                yield { eventType: 'hyperlinks', value: hyperlinksReader }
                // Read them before the entry is drained. A consumer's own
                // read(), now or later, shares this read, so it must listen
                // for 'hyperlink' before this loop moves on.
                await hyperlinksReader.read()
              }
            }
            // package rels and entries we don't parse are only drained
            break
          }
        }
        await drainEntry(raw)
        currentEntry = undefined
        currentReader = undefined
      }
      // This relies on unzipper 0.12's event order, which every read in the
      // specs pins: a complete archive must not read as truncated.
      // unzipper also ends when the input does, even between two entries.
      // At the end record it ends its readable side (push(null)), whose 'end'
      // comes just after unzipper's own when the input ends right after the
      // record, as it has read the record's bytes by then.
      await nextMacrotask()
      if (!zip.readableEnded) {
        throw new Error(
          'Zip archive is truncated: it ends before its end of central directory record',
        )
      }
    } catch (error) {
      failed = true
      throw error
    } finally {
      // Stop reading the archive once we are done with it, including when
      // reading stops early: a zip limit or parse error (also one raised while
      // the consumer iterates a worksheet) or the consumer breaking out of the
      // iteration. Detach from the input, and destroy the parser and the entry
      // it was writing so they release their buffers and inflater.
      const cleanUp = () => {
        zip.removeListener('entry', onEntry)
        stopWatchingInput()
        if (canHoldBack) stream.unpipe(zip)
        if (currentEntry && !currentEntry.readableEnded) {
          // Closing it cuts off a read of it still under way, which fails
          // with "Stream was already consumed"
          currentEntry.destroy(new Error(CONSUMED))
        }
        zip.destroy()
        // Close a file we opened ourselves; a caller-supplied stream is
        // theirs. unzipper stops reading at the end of the archive, so even a
        // complete read may not reach the end of the file.
        if (ownsStream) {
          stream.destroy()
        }
      }
      // A consumer that stops early while a read() of the current part it
      // didn't await is under way gets the rest of that part first
      const reading = !failed && currentReader && currentReader._selfRead
      if (reading) {
        reading.then(cleanUp, cleanUp)
      } else {
        cleanUp()
      }
    }

    // taken off the list as they are replayed, so each can be freed once read
    while (waitingWorkSheets.length) {
      const { sheetNo, chunks } = waitingWorkSheets.shift()
      const worksheetReader = this._createWorksheetReader(
        iterateStream(Readable.from(chunks)),
        sheetNo,
      )
      yield { eventType: 'worksheet', value: worksheetReader }
      // as above: a parse error of a read() under way fails this read
      // eslint-disable-next-line no-await-in-loop
      await worksheetReader._selfRead
    }
  }

  // Whether parse() reads the part at `path`, rather than only draining it.
  // This must match the parts the loop in parse() reads.
  _readsPart(path) {
    const { options } = this
    switch (path) {
      case 'xl/_rels/workbook.xml.rels':
      case 'xl/workbook.xml':
        return true
      case 'xl/sharedStrings.xml':
        return (
          options.sharedStrings === 'cache' || options.sharedStrings === 'emit'
        )
      case 'xl/styles.xml':
        return options.styles === 'cache'
      default:
        if (SHEET.test(path)) return options.worksheets === 'emit'
        if (SHEET_RELS.test(path)) return options.hyperlinks === 'emit'
        return false
    }
  }

  // A worksheet streams straight away once the parts it depends on have been
  // read, and is otherwise buffered until the end of the archive. As before,
  // only when shared strings are cached: with them emitted or ignored every
  // worksheet comes last, in archive order, after all other parts.
  _canStreamWorksheet() {
    return Boolean(
      this.options.sharedStrings === 'cache' &&
      (this.sharedStrings !== undefined || this._hasNoSharedStrings()) &&
      this.workbookRels &&
      this.model.sheets &&
      (this.options.styles !== 'cache' || this.stylesRead),
    )
  }

  // Whether the workbook rels, once read, list no shared strings part: a
  // workbook of only numbers has none, and there is nothing to wait for. Any
  // relationship that looks like one counts (Strict OOXML has its own type
  // URI), so a sheet never streams before shared strings that do exist.
  _hasNoSharedStrings() {
    return Boolean(
      this.workbookRels &&
      !this.workbookRels.some(
        (rel) =>
          /\/sharedStrings$/i.test(rel.Type || '') ||
          /(^|\/)sharedStrings\.xml$/i.test(rel.Target || ''),
      ),
    )
  }

  _emitEntry(payload) {
    if (this.options.entries === 'emit') {
      this.emit('entry', payload)
    }
  }

  async _parseRels(entry) {
    const xform = new RelationshipsXform()
    this.workbookRels = await xform.parseStream(iterateStream(entry))
  }

  async _parseWorkbook(entry) {
    this._emitEntry({ type: 'workbook' })

    const workbook = new WorkbookXform()
    await workbook.parseStream(iterateStream(entry))

    this.properties = workbook.map.workbookPr
    // undefined if the part has no workbook root element (e.g. a prefixed one)
    this.model = workbook.model || {}
  }

  async *_parseSharedStrings(entry) {
    this._emitEntry({ type: 'shared-strings' })
    switch (this.options.sharedStrings) {
      case 'cache':
        this.sharedStrings = []
        break
      case 'emit':
        break
      default:
        return
    }

    let text = null
    let richText = []
    let index = 0
    let font = null
    for await (const events of parseSax(iterateStream(entry))) {
      for (const { eventType, value } of events) {
        if (eventType === 'opentag') {
          const node = value
          switch (node.name) {
            case 'b':
              font = font || {}
              font.bold = true
              break
            case 'charset':
              font = font || {}
              font.charset = parseInt(node.attributes.charset, 10)
              break
            case 'color':
              font = font || {}
              font.color = {}
              if (node.attributes.rgb) {
                font.color.argb = node.attributes.argb
              }
              if (node.attributes.val) {
                font.color.argb = node.attributes.val
              }
              if (node.attributes.theme) {
                font.color.theme = node.attributes.theme
              }
              break
            case 'family':
              font = font || {}
              font.family = parseInt(node.attributes.val, 10)
              break
            case 'i':
              font = font || {}
              font.italic = true
              break
            case 'outline':
              font = font || {}
              font.outline = true
              break
            case 'rFont':
              font = font || {}
              font.name = node.value
              break
            case 'si':
              font = null
              richText = []
              text = null
              break
            case 'sz':
              font = font || {}
              font.size = parseInt(node.attributes.val, 10)
              break
            case 'strike':
              break
            case 't':
              text = null
              break
            case 'u':
              font = font || {}
              font.underline = true
              break
            case 'vertAlign':
              font = font || {}
              font.vertAlign = node.attributes.val
              break
          }
        } else if (eventType === 'text') {
          text = text ? text + value : value
        } else if (eventType === 'closetag') {
          const node = value
          switch (node.name) {
            case 'r':
              richText.push({
                font,
                text,
              })

              font = null
              text = null
              break
            case 'si':
              if (this.options.sharedStrings === 'cache') {
                this.sharedStrings.push(richText.length ? { richText } : text)
              } else if (this.options.sharedStrings === 'emit') {
                yield {
                  eventType: 'shared-strings',
                  value: {
                    index: index++,
                    text: richText.length ? { richText } : text,
                  },
                }
              }

              richText = []
              font = null
              text = null
              break
          }
        }
      }
    }
  }

  async _parseStyles(entry) {
    this._emitEntry({ type: 'styles' })
    if (this.options.styles === 'cache') {
      this.styles = new StyleManager()
      await this.styles.parseStream(iterateStream(entry))
      this.stylesRead = true
    }
  }

  _createWorksheetReader(iterator, sheetNo) {
    this._emitEntry({ type: 'worksheet', id: sheetNo })
    const worksheetReader = new WorksheetReader({
      workbook: this,
      id: sheetNo,
      iterator,
      options: this.options,
    })

    const matchingRel = (this.workbookRels || []).find(
      (rel) => rel.Target === `worksheets/sheet${sheetNo}.xml`,
    )
    const matchingSheet =
      matchingRel &&
      (this.model.sheets || []).find((sheet) => sheet.rId === matchingRel.Id)
    if (matchingSheet) {
      worksheetReader.id = matchingSheet.id
      worksheetReader.name = matchingSheet.name
      worksheetReader.state = matchingSheet.state
    }
    return worksheetReader
  }
}

// for reference - these are the valid values for options (besides the zip
// limits, maxEntries and maxUncompressedSize: see ZipReadLimits in index.d.ts)
WorkbookReader.Options = {
  worksheets: ['emit', 'ignore'],
  sharedStrings: ['cache', 'emit', 'ignore'],
  hyperlinks: ['cache', 'emit', 'ignore'],
  styles: ['cache', 'ignore'],
  entries: ['emit', 'ignore'],
}

module.exports = WorkbookReader
