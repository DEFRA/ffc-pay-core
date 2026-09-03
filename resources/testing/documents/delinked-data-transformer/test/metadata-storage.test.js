const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')

const { saveServiceMetadata, loadServiceMetadata, defaultMetadataPath } = require('../app/database/metadata-storage')

test('saveServiceMetadata writes a JSON snapshot for later reuse', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-store-'))
  const databaseName = 'ffc-pay-alerting-prd'

  const result = await saveServiceMetadata(databaseName, [
    { name: 'orders', keyColumn: 'id', include: true },
    { name: 'payments', keyColumn: 'payment_id', include: true }
  ], {
    environment: 'prd',
    outputDir: tempDir
  })

  assert.equal(result.saved, true)
  assert.equal(result.count, 2)

  const filePath = defaultMetadataPath(databaseName, { outputDir: tempDir, environment: 'prd' })
  const fileText = await fs.readFile(filePath, 'utf8')
  const parsed = JSON.parse(fileText)

  assert.equal(parsed.databaseName, databaseName)
  assert.equal(parsed.environment, 'prd')
  assert.equal(parsed.tables.length, 2)

  const loaded = await loadServiceMetadata(databaseName, { outputDir: tempDir, environment: 'prd' })
  assert.equal(loaded.tables.length, 2)
  assert.equal(loaded.tables[0].name, 'orders')
})
