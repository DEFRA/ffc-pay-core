const fs = require('fs')
const path = require('path')
const { anonymizeOrganisations } = require('../faker/map-data-org-faker')

function parseCopyStatement(sqlContent, tableName) {
  // Regex to match COPY statements with their data blocks
  const copyRegex = new RegExp(
    `COPY\\s+(\\w+)\\.(["']?${tableName}["']?)\\s+\\((.*?)\\)\\s+FROM\\s+stdin;([\\s\\S]*?)^\\\\.`,
    'gm'
  )

  const match = copyRegex.exec(sqlContent)
  if (!match) return null

  const schema = match[1]
  const tableNameWithQuotes = match[2]
  const columnDef = match[3]
  const dataBlock = match[4]

  const columns = columnDef.split(',').map(c => c.trim())
  const rows = []
  const dataLines = dataBlock.trim().split('\n')

  dataLines.forEach(line => {
    if (!line.trim()) return

    const values = line.split('\t').map(v => {
      if (v === '\\N') return null
      return v
    })

    const row = {}
    columns.forEach((col, i) => {
      const cleanCol = col.replace(/"/g, '')
      row[cleanCol] = values[i]
    })
    rows.push(row)
  })

  return {
    schema,
    tableName: tableNameWithQuotes,
    columns,
    rows,
    original: match[0],
    startIndex: match.index,
    endIndex: match.index + match[0].length
  }
}

function formatAsCopyStatement(tableInfo, transformedRows) {
  const { schema, tableName, columns } = tableInfo

  const header = `COPY ${schema}.${tableName} (${columns.join(', ')}) FROM stdin;`

  const dataRows = transformedRows.map(row => {
    return columns.map(col => {
      const cleanCol = col.replace(/"/g, '')
      const val = row[cleanCol]

      if (val === null || val === undefined) return '\\N'
      return String(val)
    }).join('\t')
  }).join('\n')

  return `${header}\n${dataRows}\n\\.`
}

function transformAll() {
  console.log('===== SQL Data Transformation Process =====')
  const dumpDir = path.resolve(process.cwd(), '../../dumps')
  console.log(`Looking for dump files in: ${dumpDir}`)

  /*
  Configuration mapping tables to their transformers and target databases
  This will need ordering so any transformations that effect other maps come first
  and the affected maps will need to allow for the transformation
  For example, changing frn upstream will affect the organisations map so that needs to be run first
  */
  const transformConfig = {
    'organisations-data': {
      tableName: 'organisations',
      transformer: anonymizeOrganisations,
      database: 'ffc-doc-statement-data-test',
      files: ['ffc-doc-statement-data-test_full.sql']
    },
    'organisations-constructor': {
      tableName: 'organisations',
      transformer: anonymizeOrganisations,
      database: 'ffc-doc-statement-constructor-test',
      files: ['ffc-doc-statement-constructor-test_full.sql']
    },
    // Add more table configs as needed following this structure
  }

  // Track statistics
  const stats = {
    tablesProcessed: 0,
    rowsTransformed: 0,
    seedingStats: {}
  }

  Object.entries(transformConfig).forEach(([configKey, config]) => {
    const { tableName, transformer, database, files } = config  // Add tableName here
    const databaseDir = path.join(dumpDir, database)

    if (!fs.existsSync(databaseDir)) {
      console.error(`❌ Database directory not found: ${databaseDir}`)
      return
    }

    console.log(`\n🔍 Looking for ${configKey} data in ${database}`)

    const matchingFiles = fs.readdirSync(databaseDir)
      .filter(f => files.includes(f))

    console.log(`📋 Found ${matchingFiles.length} matching files for ${tableName} in ${database}`)

    matchingFiles.forEach(file => {
      const filePath = path.join(databaseDir, file)
      console.log(`\n📝 Processing ${file} with ${tableName} transformer`)

      let sqlContent = fs.readFileSync(filePath, 'utf8')

      const tableInfo = parseCopyStatement(sqlContent, tableName)

      if (!tableInfo) {
        console.log(`⚠️ No COPY statement found for ${tableName} in ${file}`)
        return
      }

      console.log(`✅ Found COPY statement for ${tableName} with ${tableInfo.rows.length} rows`)

      const transformedRows = transformer(tableInfo.rows)
      console.log(`🔄 Transformed ${transformedRows.length} rows for ${tableName}`)

      if (transformedRows.length > 0 && transformedRows[0]._seedInfo) {
        const seedCounts = transformedRows.reduce((acc, row) => {
          const prop = row._seedInfo.usedProperty
          acc[prop] = (acc[prop] || 0) + 1
          return acc
        }, {})

        console.log(`🌱 Seeding statistics:`)
        Object.entries(seedCounts).forEach(([prop, count]) => {
          console.log(`   - ${count} records seeded using '${prop}'`)
          stats.seedingStats[prop] = (stats.seedingStats[prop] || 0) + count
        })
      }

      const cleanRows = transformedRows.map(row => {
        const cleanRow = { ...row }
        Object.keys(cleanRow).forEach(key => {
          if (key.startsWith('_')) delete cleanRow[key]
        })
        return cleanRow
      })

      const transformedCopy = formatAsCopyStatement(tableInfo, cleanRows)
      sqlContent =
        sqlContent.substring(0, tableInfo.startIndex) +
        transformedCopy +
        sqlContent.substring(tableInfo.endIndex)

      // Write back to the same file
      fs.writeFileSync(filePath, sqlContent)
      console.log(`💾 Updated ${file} with anonymized ${tableName} data in-place`)
      stats.tablesProcessed++
      stats.rowsTransformed += transformedRows.length
    })
  })

  console.log('\n===== Transformation Summary =====')
  console.log(`✅ Processed ${stats.tablesProcessed} tables`)
  console.log(`✅ Transformed ${stats.rowsTransformed} total rows`)

  if (Object.keys(stats.seedingStats).length > 0) {
    console.log('🌱 Seeding property usage:')
    Object.entries(stats.seedingStats).forEach(([prop, count]) => {
      console.log(`   - ${prop}: ${count} records`)
    })
  }

  console.log('✨ Transformation complete!')
}

module.exports = { transformAll }

if (require.main === module) {
  console.log('Starting data transformation process...')
  try {
    transformAll()
    console.log('Data transformation completed successfully')
  } catch (error) {
    console.error('❌ Error during data transformation:', error)
    process.exit(1)
  }
}