const fs = require('fs')
const { EventEmitter, on } = require('events')
const { Readable } = require('stream')
const { finished } = require('stream/promises')
const unzip = require('unzipper')
const iterateStream = require('../../utils/iterate-stream')

const { checkOpen } = iterateStream
const parseSax = require('../../utils/parse-sax')
const ZipLimits = require('../../utils/zip-limits')

const StyleManager = require('../../xlsx/xform/style/styles-xform')
const WorkbookXform = require('../../xlsx/xform/book/workbook-xform')
const RelationshipsXform = require('../../xlsx/xform/core/relationships-xform')

const WorksheetReader = require('./worksheet-reader')
const HyperlinkReader = require('./hyperlink-reader')

// Parts parse() reads
const PARTS = new Map([
  ['xl/_rels/workbook.xml.rels', 'workbook-rels'],
  ['xl/workbook.xml', 'workbook'],
  ['xl/sharedStrings.xml', 'shared-strings'],
  ['xl/styles.xml', 'styles'],
])

// The part parse() routes an entry to, or undefined for an entry it only
// drains (media etc.)
function classifyEntry(entryPath) {
  const type = PARTS.get(entryPath)
  if (type) {
    return { type }
  }
  let match = entryPath.match(/xl\/worksheets\/sheet(\d+)[.]xml/)
  if (match) {
    return { type: 'worksheet', sheetNo: match[1] }
  }
  match = entryPath.match(/xl\/worksheets\/_rels\/sheet(\d+)[.]xml[.]rels/)
  if (match) {
    return { type: 'hyperlinks', sheetNo: match[1] }
  }
  return undefined
}

class WorkbookReader extends EventEmitter {
  constructor(input, options = {}) {
    super()

    this.input = input
    // Kept apart from this.options, which options given to read()/parse()
    // replace: those apply their own zip limits to that call only
    const { maxEntries, maxUncompressedSize } = options
    this.zipLimits = { maxEntries, maxUncompressedSize }

    this.options = {
      worksheets: 'emit',
      sharedStrings: 'cache',
      hyperlinks: 'ignore',
      styles: 'ignore',
      entries: 'ignore',
      ...options,
    }

    this.styles = new StyleManager()
    this.styles.init()
    // Filled from xl/workbook.xml; empty if an archive lacks it, so readers of
    // them don't crash
    this.model = {}
    this.properties = {}
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
    if (options) {
      this.options = options
    }
    // A limit options set applies to this call; any other comes from the
    // constructor
    const limitOptions = { ...this.zipLimits }
    Object.keys(limitOptions).forEach((name) => {
      if (options && options[name] !== undefined) {
        limitOptions[name] = options[name]
      }
    })
    const limits = new ZipLimits(limitOptions, ZipLimits.STREAMING_DEFAULTS)
    input = input || this.input
    // a stream we open ourselves is ours to close
    const ownsStream = typeof input === 'string'
    const stream = (this.stream = this._getStream(input))
    // Piping a stream that failed or closed would leave the zip parser
    // waiting forever
    checkOpen(stream, 'Could not read input: the stream has failed or closed')
    const zip = unzip.Parse()
    // pipe() doesn't forward errors: fail the zip parser on a read error (e.g.
    // a missing file), which would otherwise hang or crash the process
    const onSourceError = (error) => zip.destroy(error)
    stream.on('error', onSourceError)
    stream.pipe(zip)

    // unzipper parses on to the next entry as soon as it has buffered one,
    // without waiting for it to be read, so the limits are checked as it
    // parses each entry rather than when this loop gets to it: otherwise an
    // archive of many small entries would be buffered whole first. A limit
    // hit stops the parser.
    // the entry unzipper is writing: only the latest can be unfinished
    let lastEntry
    const onEntry = (entry) => {
      lastEntry = entry
      try {
        limits.addEntry()
        entry.counted = limits.countStream(entry)
        if (entry.counted !== entry) {
          entry.counted.on('error', (error) => {
            if (error.code === ZipLimits.ERROR_CODE) zip.destroy(error)
          })
        }
      } catch (error) {
        zip.destroy(error)
      }
    }
    zip.on('entry', onEntry)

    // unzipper reports a truncated or corrupt archive on the zip stream only,
    // leaving an entry it was still writing open forever: fail that entry
    // too, so whatever reads or drains it settles (it may still be queued
    // for this loop, which gets queued entries before the error), and stop
    // the parser
    zip.on('error', (error) => {
      if (lastEntry && !lastEntry.writableFinished) {
        lastEntry.destroy(error)
      }
      if (!zip.destroyed) zip.destroy(error)
    })

    let currentEntry
    // the reader handed out for the current entry, if any
    let currentReader

    // worksheets, deferred for parsing after shared strings reading
    const waitingWorkSheets = []

    try {
      // ends when unzipper reaches the end of the archive
      for await (const [rawEntry] of on(zip, 'entry', { close: ['close'] })) {
        currentEntry = rawEntry
        currentReader = undefined
        const part = classifyEntry(rawEntry.path)
        // Its inflated bytes are counted as they arrive (see onEntry), whether
        // it is parsed or (media etc.) drained without being buffered
        const entry = rawEntry.counted
        // the entry that hit a limit still arrives, before the parser's error
        if (!entry) throw zip.errored
        switch (part?.type) {
          case 'workbook-rels':
            await this._parseRels(entry)
            break
          case 'workbook':
            await this._parseWorkbook(entry)
            break
          case 'shared-strings':
            yield* this._parseSharedStrings(entry)
            break
          case 'styles':
            await this._parseStyles(entry)
            break
          case 'worksheet':
            if (this._canStreamWorksheet()) {
              const worksheetReader = this._createWorksheetReader(
                iterateStream(entry),
                part.sheetNo,
              )
              currentReader = worksheetReader
              yield* this._emitWorksheet(worksheetReader)
              // A worksheet being read or iterated (maybe in the background)
              // must finish before its entry can be drained
              if (worksheetReader._reading) await worksheetReader._reading
            } else {
              // buffer worksheet data in memory for deferred parsing
              const chunks = await entry.toArray()
              waitingWorkSheets.push({ sheetNo: part.sheetNo, chunks })
            }
            break
          case 'hyperlinks':
            this._emitEntry({ type: 'hyperlinks', id: part.sheetNo })
            // Only 'emit' hands them out; nothing reads them otherwise
            if (this.options.hyperlinks === 'emit') {
              const hyperlinksReader = new HyperlinkReader({
                workbook: this,
                id: part.sheetNo,
                iterator: iterateStream(entry),
                options: this.options,
              })
              currentReader = hyperlinksReader
              yield { eventType: 'hyperlinks', value: hyperlinksReader }
              // Read them before the entry is drained. A consumer's own
              // read(), now or later, shares this read, so it must listen for
              // 'hyperlink' before this loop moves on.
              await hyperlinksReader.read()
            }
            break
          default:
            // package rels and entries we don't parse are only drained
            break
        }
        // Drain whatever the parsers left unread, and settle on its end or
        // error: a part's bytes are still counted as they drain, and a
        // truncated archive fails the entry being read (see above)
        await finished(entry.resume())
      }
    } finally {
      // Stop reading the archive once we are done with it, including when
      // reading stops early: a zip limit or parse error (also one raised while
      // the consumer iterates a worksheet) or the consumer breaking out of the
      // iteration. Detach from the input, and destroy the parser and the entry
      // it was writing so they release their buffers and inflater.
      zip.removeListener('entry', onEntry)
      stream.removeListener('error', onSourceError)
      // a legacy (pre-streams2) stream has no unpipe()
      if (typeof stream.unpipe === 'function') stream.unpipe(zip)
      if (currentEntry && !currentEntry.readableEnded) {
        // Closing it cuts off a read of it still under way; that's the
        // consumer stopping, not the part failing
        if (currentReader) currentReader._abandoned = true
        currentEntry.destroy()
      }
      zip.destroy()
      // Close a file we opened ourselves; a caller-supplied stream is theirs.
      // unzipper stops reading at the end of the archive, so even a complete
      // read may not reach the end of the file.
      if (ownsStream) {
        stream.destroy()
      }
    }

    for (const { sheetNo, chunks } of waitingWorkSheets) {
      const worksheetReader = this._createWorksheetReader(
        iterateStream(Readable.from(chunks)),
        sheetNo,
      )
      yield* this._emitWorksheet(worksheetReader)
    }
  }

  // A worksheet streams straight away once the parts it depends on have been
  // read, and is otherwise buffered until the end of the archive
  _canStreamWorksheet() {
    return (
      this.workbookRels &&
      this.model.sheets &&
      (this.options.sharedStrings !== 'cache' || this.sharedStrings) &&
      (this.options.styles !== 'cache' || this.stylesRead)
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
    this.model = workbook.model
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
                  index: index++,
                  text: richText.length ? { richText } : text,
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

  *_emitWorksheet(worksheetReader) {
    if (this.options.worksheets === 'emit') {
      yield { eventType: 'worksheet', value: worksheetReader }
    }
  }
}

// for reference - these are the valid values for options
WorkbookReader.Options = {
  worksheets: ['emit', 'ignore'],
  sharedStrings: ['cache', 'emit', 'ignore'],
  hyperlinks: ['cache', 'emit', 'ignore'],
  styles: ['cache', 'ignore'],
  entries: ['emit', 'ignore'],
}

module.exports = WorkbookReader
