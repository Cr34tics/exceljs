const HyperlinkReader = verquire('stream/xlsx/hyperlink-reader')
const Enums = verquire('doc/enums')

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/1" TargetMode="External"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/2" TargetMode="External"/>
</Relationships>`

async function* chunks() {
  yield Buffer.from(RELS)
}

function createReader() {
  return new HyperlinkReader({
    workbook: {},
    id: 1,
    iterator: chunks(),
    options: { hyperlinks: 'emit' },
  })
}

describe('HyperlinkReader', () => {
  it('emits each hyperlink relationship, then finishes', async () => {
    const reader = createReader()
    const hyperlinks = []
    let finished = false
    reader.on('hyperlink', (hyperlink) => hyperlinks.push(hyperlink))
    reader.on('finished', () => {
      finished = true
    })
    await reader.read()
    expect(hyperlinks).to.deep.equal([
      {
        type: Enums.RelationshipType.Hyperlink,
        rId: 'rId1',
        target: 'https://example.com/1',
        targetMode: 'External',
      },
      {
        type: Enums.RelationshipType.Hyperlink,
        rId: 'rId3',
        target: 'https://example.com/2',
        targetMode: 'External',
      },
    ])
    expect(finished).to.equal(true)
  })

  it('shares one read between callers', async () => {
    const reader = createReader()
    let delivered = 0
    reader.on('hyperlink', () => delivered++)
    expect(reader.read()).to.equal(reader.read())
    await reader.read()
    expect(delivered).to.equal(2)
  })
})
