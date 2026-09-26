const HyperlinkReader = verquire('stream/xlsx/hyperlink-reader')
const Enums = verquire('doc/enums')

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/1" TargetMode="External"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/2" TargetMode="External"/>
</Relationships>`

async function* chunks() {
  yield Buffer.from(RELS)
}

describe('HyperlinkReader', () => {
  it('counts and iterates cached hyperlinks', async () => {
    const reader = new HyperlinkReader({
      workbook: {},
      id: 1,
      iterator: chunks(),
      options: { hyperlinks: 'cache' },
    })
    await reader.read()
    expect(reader.count).to.equal(2)
    expect(reader.hyperlinks.rId1.type).to.equal(
      Enums.RelationshipType.Hyperlink,
    )
    const targets = []
    reader.each((hyperlink) => targets.push(hyperlink.target))
    expect(targets).to.deep.equal([
      'https://example.com/1',
      'https://example.com/2',
    ])
  })

  it('shares one read between callers', async () => {
    const reader = new HyperlinkReader({
      workbook: {},
      id: 1,
      iterator: chunks(),
      options: { hyperlinks: 'cache' },
    })
    expect(reader.read()).to.equal(reader.read())
  })
})
