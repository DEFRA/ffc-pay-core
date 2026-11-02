const fs = require('node:fs/promises')
const path = require('node:path')

function defaultMetadataPath (databaseName, options = {}) {
  const outputDir = options.outputDir || path.resolve(__dirname, '../../metadata')
  const environment = options.environment || 'prd'
  const safeDatabaseName = String(databaseName || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(outputDir, `${safeDatabaseName}-${environment}.json`)
}

async function ensureDirectoryExists (dirPath) {
  await fs.mkdir(dirPath, { recursive: true })
}

async function saveServiceMetadata (databaseName, tables = [], options = {}) {
  const environment = options.environment || 'prd'
  const outputDir = options.outputDir || path.resolve(__dirname, '../../metadata')
  const filePath = defaultMetadataPath(databaseName, { outputDir, environment })

  await ensureDirectoryExists(outputDir)

  const payload = {
    databaseName,
    environment,
    savedAt: new Date().toISOString(),
    tables: Array.isArray(tables)
      ? tables.map(table => ({
        name: table.name,
        keyColumn: table.keyColumn || null,
        include: table.include !== false,
        source: table.source || 'discovered'
      }))
      : []
  }

  await fs.writeFile(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8')

  return {
    saved: true,
    filePath,
    count: payload.tables.length
  }
}

async function loadServiceMetadata (databaseName, options = {}) {
  const environment = options.environment || 'prd'
  const outputDir = options.outputDir || path.resolve(__dirname, '../../metadata')
  const filePath = defaultMetadataPath(databaseName, { outputDir, environment })

  try {
    const content = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(content)
    return {
      filePath,
      databaseName: parsed.databaseName || databaseName,
      environment: parsed.environment || environment,
      tables: Array.isArray(parsed.tables) ? parsed.tables : []
    }
  } catch (error) {
    return {
      filePath,
      databaseName,
      environment,
      tables: [],
      missing: true
    }
  }
}

module.exports = {
  defaultMetadataPath,
  saveServiceMetadata,
  loadServiceMetadata,
  ensureDirectoryExists
}
