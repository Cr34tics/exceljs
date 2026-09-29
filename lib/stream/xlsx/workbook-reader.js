const fs = require('fs')
const { EventEmitter, on } = require('events')
const { PassThrough, Readable, finished: eos } = require('stream')
const { finished } = require('stream/promises')
// captured now, so fake timers installed later can't stall the read
const { setImmediate: nextMacrotask } = require('timers/promises')
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

// Entries unzipper may parse ahead of the read loop before the input is held
// back (see parse())
const MAX_QUEUED_ENTRIES = 16

// The zip limit options among `options`, leaving out undefined ones
function pickLimitOptions(options) {
  const picked = {}
  ZipLimits.OPTION_NAMES.forEach((name) => {
    if (options && options[name] !== undefined) {
      picked[name] = options[name]
    }
  })
  return picked
}

// Drains the rest of a zip entry and settles on its end or error. A
// consumer that stopped reading its part halfway is cut off: `reader` (the
// reader handed out for it, if any) then just ends.
async function drainEntry(entry, reader) {
  const { part } = entry
  if (!part.readableEnded) {
    if (reader) reader._abandoned = true
    entry.unpipe(part)
    part.destroy()
  }
  await finished(entry.resume())
}

class WorkbookReader extends EventEmitter {
  constructor(input, options) {
    super()
    options = options || {}

    this.input = input
    // Kept apart from this.options, which options given to read()/parse()
    // replace: those apply their own zip limits to that call only
    this.zipLimits = pickLimitOptions(options)

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
    // A limit options set applies to this call; any other comes from the
    // constructor (checked before the options are taken on)
    const limits = new ZipLimits(
      { ...this.zipLimits, ...pickLimitOptions(options) },
      ZipLimits.STREAMING_DEFAULTS,
    )
    if (options) {
      // they replace the constructor's options, as they always have
      this.options = options
    }
    // what a previous read learnt of another archive mustn't leak into this
    this.workbookRels = undefined
    this.model = {}
    this.properties = {}
    this.sharedStrings = undefined
    this.sharedStringsRead = false
    this.styles = new StyleManager()
    this.styles.init()
    this.stylesRead = false
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
    // Each entry is piped into the part its parser reads, so the entry can
    // still be drained if a consumer stops reading the part halfway.
    // the entry unzipper is writing: only the latest can be unfinished
    let lastEntry
    // unzipper doesn't wait for this loop either: once entries are queued
    // for it, hold the input back until the loop catches up, so a slow
    // consumer doesn't let small entries pile up in memory
    let queued = 0
    let heldBack = false
    const canHoldBack = typeof stream.unpipe === 'function'
    const onEntry = (entry) => {
      lastEntry = entry
      queued += 1
      if (canHoldBack && !heldBack && queued >= MAX_QUEUED_ENTRIES) {
        heldBack = true
        stream.unpipe(zip)
      }
      try {
        limits.addEntry()
      } catch (error) {
        zip.destroy(error)
        return
      }
      const part = new PassThrough()
      // Its errors reach its reader's iterator, and the loop's drain of the
      // entry, not an 'error' event: once neither listens (it was read, or
      // the read stopped) there is nobody to tell
      part.on('error', () => {})
      // a failed or cut-off entry fails its part too
      eos(entry, (error) => {
        if (error) part.destroy(error)
      })
      if (limits.maxUncompressedSize !== Infinity) {
        entry.on('data', (chunk) => {
          try {
            limits.addBytes(chunk.length)
          } catch (error) {
            entry.destroy(error)
            zip.destroy(error)
          }
        })
      }
      entry.pipe(part)
      entry.part = part
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
      zip.destroy(error)
    })

    let currentEntry
    // the reader handed out for the current entry, if any
    let currentReader
    let failed = false

    // worksheets, deferred for parsing after shared strings reading
    const waitingWorkSheets = []

    try {
      for await (const [rawEntry] of on(zip, 'entry', { close: ['end'] })) {
        currentEntry = rawEntry
        currentReader = undefined
        queued -= 1
        if (heldBack && queued < MAX_QUEUED_ENTRIES / 2) {
          heldBack = false
          stream.pipe(zip)
        }
        // what the entry's parser reads; its bytes are counted as they arrive
        // (see onEntry), whether it is parsed or (media etc.) only drained
        const entry = rawEntry.part
        // the entry that hit a limit still arrives, before the parser's error
        if (!entry) throw zip.errored
        const part = classifyEntry(rawEntry.path)
        switch (part?.type) {
          case 'workbook-rels':
            await this._parseRels(entry)
            break
          case 'workbook':
            await this._parseWorkbook(entry)
            break
          case 'shared-strings':
            yield* this._parseSharedStrings(entry)
            this.sharedStringsRead = true
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
              // A read() of it runs by itself: let it finish. A consumer
              // iterating it is done with it once this loop moves on.
              await worksheetReader._selfRead
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
        await drainEntry(rawEntry, currentReader)
        currentEntry = undefined
        currentReader = undefined
      }
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
        // a legacy (pre-streams2) stream has no unpipe()
        if (typeof stream.unpipe === 'function') stream.unpipe(zip)
        if (currentEntry && !currentEntry.readableEnded) {
          // Closing it cuts off a read of it still under way; that's the
          // consumer stopping, not the part failing
          if (currentReader) currentReader._abandoned = true
          currentEntry.destroy()
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

    for (const { sheetNo, chunks } of waitingWorkSheets) {
      const worksheetReader = this._createWorksheetReader(
        iterateStream(Readable.from(chunks)),
        sheetNo,
      )
      yield* this._emitWorksheet(worksheetReader)
      // as above: a parse error of a read() under way fails this read
      // eslint-disable-next-line no-await-in-loop
      await worksheetReader._selfRead
    }
  }

  // A worksheet streams straight away once the parts it depends on have been
  // read, and is otherwise buffered until the end of the archive. As before,
  // only when shared strings are cached: with them emitted or ignored every
  // worksheet comes last, in archive order, after all other parts.
  _canStreamWorksheet() {
    return (
      this.options.sharedStrings === 'cache' &&
      this.sharedStringsRead &&
      this.workbookRels &&
      this.model.sheets &&
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
