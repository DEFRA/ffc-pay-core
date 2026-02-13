const fs = require('fs')
const path = require('path')
const readline = require('readline')
const { anonymizeOrganisations } = require('../faker/map-data-org-faker')

const TARGET_TABLES = [
  { tableName: 'organisations', transformer: anonymizeOrganisations }
  // Add more tables/transformers here if needed
]

function parseCopyHeader (line, tableName) {
  // Matches: COPY schema.table (col1, col2, ...) FROM stdin;
  const regex = new RegExp(`^COPY\\s+(\\w+)\\.(["']?${tableName}["']?)\\s+\\((.*?)\\)\\s+FROM\\s+stdin;`, 'i')
  const match = line.match(regex)
  if (!match) return null
  return {
    schema: match[1],
    tableName: match[2],
    columns: match[3].split(',').map(c => c.trim())
  }
}

async function transformFile (filePath, tableName, transformer) {
  const tempPath = filePath + '.tmp'
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })
  const output = fs.createWriteStream(tempPath, { encoding: 'utf8' })

  let inCopyBlock = false
  let copyHeader = null
  let copyRows = []
  let copyEndFound = false
  let totalTransformed = 0

  for await (const line of rl) {
    if (!inCopyBlock) {
      const header = parseCopyHeader(line, tableName)
      if (header) {
        inCopyBlock = true
        copyHeader = header
        copyRows = []
        output.write(line + '\n')
        continue
      }
      output.write(line + '\n')
    } else {
      if (line.trim() === '\\.') {
        copyEndFound = true
        const rows = copyRows.map(rowLine => {
          const values = rowLine.split('\t').map(v => v === '\\N' ? null : v)
          const row = {}
          copyHeader.columns.forEach((col, i) => row[col.replace(/"/g, '')] = values[i])
          return row
        })
        const transformedRows = transformer(rows)
        totalTransformed += transformedRows.length
        // Clean up any _seedInfo etc
        const cleanRows = transformedRows.map(row => {
          const cleanRow = { ...row }
          Object.keys(cleanRow).forEach(key => { if (key.startsWith('_')) delete cleanRow[key] })
          return cleanRow
        })
        // Write transformed rows
        cleanRows.forEach(row => {
          const line = copyHeader.columns.map(col => {
            const val = row[col.replace(/"/g, '')]
            return val === null || val === undefined ? '\\N' : String(val)
          }).join('\t')
          output.write(line + '\n')
        })
        output.write('\\.\n')
        inCopyBlock = false
        copyHeader = null
        copyRows = []
        copyEndFound = false
        continue
      }
      copyRows.push(line)
    }
  }

  output.end()
  await new Promise(resolve => output.on('finish', resolve))
  fs.renameSync(tempPath, filePath)
  return totalTransformed
}

async function transformAll () {
  console.log('===== Streaming SQL Data Transformation =====')
  const dumpDir = path.resolve(__dirname, '../../test-dumps')
  const databases = fs.readdirSync(dumpDir).filter(f => fs.statSync(path.join(dumpDir, f)).isDirectory())

  for (const database of databases) {
    const dbDir = path.join(dumpDir, database)
    const files = fs.readdirSync(dbDir).filter(f => f.endsWith('.sql'))
    for (const file of files) {
      const filePath = path.join(dbDir, file)
      let changed = false
      for (const { tableName, transformer } of TARGET_TABLES) {
        const transformed = await transformFile(filePath, tableName, transformer)
        if (transformed > 0) {
          changed = true
          console.log(`✅ Anonymized ${tableName} in ${file} (${transformed} rows)`)
        }
      }
      if (changed) {
        console.log(`💾 Updated file: ${filePath}`)
      }
    }
  }
  console.log('✨ Streaming transformation complete!')
}

module.exports = { transformAll }

if (require.main === module) {
  transformAll().catch(error => {
    console.error('❌ Error during streaming data transformation:', error)
    process.exit(1)
  })
}
