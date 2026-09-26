const fs = require('fs')
const { EventEmitter } = require('events')
const { Readable } = require('stream')
const { finished } = require('stream/promises')
const unzip = require('unzipper')
const iterateStream = require('../../utils/iterate-stream')

const { checkUnread } = iterateStream
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
    // a stream we open ourselves is ours to close
    this.ownsStream = typeof input === 'string'
    if (this.ownsStream) {
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
      // These replace the constructor's options, as they always have, but
      // don't silently drop its zip limits
      const { maxEntries, maxUncompressedSize } = this.options
      this.options = { maxEntries, maxUncompressedSize, ...options }
    }
    const limits = new ZipLimits(this.options, ZipLimits.STREAMING_DEFAULTS)
    const stream = (this.stream = this._getStream(input || this.input))
    // Piping a stream that failed, closed or was partly read would leave the
    // zip parser waiting forever or reading from the middle of the archive
    checkUnread(
      stream,
      'Could not read input: the stream was already read from or closed',
    )
    const zip = unzip.Parse({ forceStream: true })
    // pipe() doesn't forward errors: fail the zip parser on a read error (e.g.
    // a missing file), which would otherwise hang or crash the process
    const onSourceError = (error) => zip.destroy(error)
    stream.on('error', onSourceError)
    stream.pipe(zip)

    // unzipper reports a truncated or corrupt archive on the zip stream only,
    // leaving an entry it was still writing open forever; fail that entry too
    // so that whatever is reading or draining it settles
    let currentEntry
    let zipError
    zip.on('error', (error) => {
      zipError = error
      if (currentEntry && !currentEntry.writableFinished) {
        currentEntry.destroy(error)
      }
    })

    // worksheets, deferred for parsing after shared strings reading
    const waitingWorkSheets = []

    try {
      for await (const rawEntry of iterateStream(zip)) {
        currentEntry = rawEntry
        // entries the parser queued before failing are yielded first, and
        // would never finish (finally destroys this one)
        if (zipError) throw zipError
        limits.addEntry()
        const part = classifyEntry(rawEntry.path)
        // Every entry is read through a counting stream, so its inflated bytes
        // are checked against maxUncompressedSize as they arrive, whether it is
        // parsed or (media etc.) drained without being buffered
        const entry = limits.countStream(rawEntry)
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
            if (this.sharedStrings && this.workbookRels) {
              yield* this._parseWorksheet(iterateStream(entry), part.sheetNo)
            } else {
              // buffer worksheet data in memory for deferred parsing
              const chunks = []
              entry.on('data', (chunk) => chunks.push(chunk))
              await finished(entry)
              waitingWorkSheets.push({ sheetNo: part.sheetNo, chunks })
            }
            break
          case 'hyperlinks': {
            const hyperlinksReader = this._parseHyperlinks(entry, part.sheetNo)
            if (this.options.hyperlinks === 'emit') {
              yield { eventType: 'hyperlinks', value: hyperlinksReader }
            }
            // Like a worksheet the event API reads, finish them before the
            // entry is drained: a consumer that defers its read() (or never
            // reads them) shares this read instead of finding them consumed
            await hyperlinksReader.read()
            break
          }
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
      stream.removeListener('error', onSourceError)
      stream.unpipe(zip)
      if (currentEntry && !currentEntry.readableEnded) {
        currentEntry.destroy()
      }
      zip.destroy()
      // Close a file we opened ourselves; a caller-supplied stream is theirs.
      // unzipper stops reading at the end of the archive, so even a complete
      // read may not reach the end of the file.
      if (this.ownsStream) {
        stream.destroy()
      }
    }

    for (const { sheetNo, chunks } of waitingWorkSheets) {
      const replayStream = Readable.from(chunks)
      yield* this._parseWorksheet(iterateStream(replayStream), sheetNo)
    }
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
    }
  }

  *_parseWorksheet(iterator, sheetNo) {
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
    if (this.options.worksheets === 'emit') {
      yield { eventType: 'worksheet', value: worksheetReader }
    }
  }

  _parseHyperlinks(entry, sheetNo) {
    this._emitEntry({ type: 'hyperlinks', id: sheetNo })
    return new HyperlinkReader({
      workbook: this,
      id: sheetNo,
      iterator: iterateStream(entry),
      options: this.options,
    })
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
