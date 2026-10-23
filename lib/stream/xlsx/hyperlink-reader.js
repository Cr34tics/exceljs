const parseSax = require('../../utils/parse-sax')

const Enums = require('../../doc/enums')
const RelType = require('../../xlsx/rel-type')
const PartReader = require('./part-reader')

// A worksheet's hyperlink relationships, handed out with hyperlinks: 'emit'.
// read() (see PartReader) emits each as a 'hyperlink' event. The workbook
// reader reads them itself before moving on, and a consumer's read(), then or
// later, shares that read: listen for 'hyperlink' in the workbook reader's
// 'hyperlinks' handler.
class HyperlinkReader extends PartReader {
  async _readPart() {
    for await (const events of parseSax(this.iterator)) {
      for (const { eventType, value } of events) {
        if (
          eventType === 'opentag' &&
          value.name === 'Relationship' &&
          value.attributes.Type === RelType.Hyperlink
        ) {
          this.emit('hyperlink', {
            type: Enums.RelationshipType.Hyperlink,
            rId: value.attributes.Id,
            target: value.attributes.Target,
            targetMode: value.attributes.TargetMode,
          })
        }
      }
    }
  }
}

module.exports = HyperlinkReader
