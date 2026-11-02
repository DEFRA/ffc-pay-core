#!/usr/bin/env node

const fs = require('node:fs/promises')
const path = require('node:path')
const { createConnection, getEnvironmentSuffix } = require('./db-connection')
const config = require('../config')

function parseArgs (argv = process.argv.slice(2)) {
  const args = {
    service: null,
    services: [],
    servicesFile: null,
    sourceEnvironment: config.sourceEnvironment || 'recovery',
    targetEnvironment: config.targetEnvironment || 'test',
    includeStats: false,
    limit: null,
    metadataDir: path.resolve(__dirname, '../../metadata'),
    help: false
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--service') args.service = argv[++i]
    else if (arg === '--services-file') {
      args.servicesFile = path.resolve(process.cwd(), argv[++i])
      const loaded = require(args.servicesFile)
      args.services = loaded.services || loaded
    }
    else if (arg === '--source-environment') args.sourceEnvironment = argv[++i]
    else if (arg === '--target-environment') args.targetEnvironment = argv[++i]
    else if (arg === '--include-stats') args.includeStats = true
    else if (arg === '--limit') args.limit = Number(argv[++i])
    else if (arg === '--metadata-dir') args.metadataDir = path.resolve(process.cwd(), argv[++i])
    else if (arg === '--help' || arg === '-h') args.help = true
  }

  return args
}

function normaliseTableName (value) {
  return String(value || '').trim()
}

async function listMetadataFiles (metadataDir) {
  const entries = await fs.readdir(metadataDir, { withFileTypes: true })
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => path.join(metadataDir, entry.name))
    .sort()
}

async function readMetadataFile (filePath) {
  const content = await fs.readFile(filePath, 'utf8')
  const parsed = JSON.parse(content)
  return {
    databaseName: parsed.databaseName || path.basename(filePath, '.json'),
    environment: parsed.environment || 'unknown',
    tables: Array.isArray(parsed.tables)
      ? parsed.tables.map(table => normaliseTableName(table.name || table)).filter(Boolean)
      : []
  }
}

function resolveTargetDatabaseName (sourceDbName, sourceEnvironment, targetEnvironment) {
  const sourceSuffix = getEnvironmentSuffix(sourceEnvironment)
  const targetSuffix = getEnvironmentSuffix(targetEnvironment)
  const value = (sourceDbName || '').toLowerCase()

  if (sourceSuffix && value.endsWith(sourceSuffix)) {
    return `${sourceDbName.slice(0, sourceDbName.length - sourceSuffix.length)}${targetSuffix}`
  }

  return `${sourceDbName}${targetSuffix}`
}

function serviceMatchesFilter (metadata, filter) {
  if (!filter) return true
  const databaseName = metadata.databaseName.toLowerCase()
  const baseName = databaseName.replace(/-recovery$|-prd$|-pre$|-test$|-dev$/i, '')
  const shortName = baseName.replace(/^ffc-pay-/, '')
  const filterLower = filter.toLowerCase()

  return databaseName === filterLower ||
    baseName === filterLower ||
    shortName === filterLower
}

async function resolveServices (options) {
  const metadataFiles = await listMetadataFiles(options.metadataDir)
  const services = []

  for (const metadataFile of metadataFiles) {
    const metadata = await readMetadataFile(metadataFile)
    if (!metadata.tables.length) continue
    if (!serviceMatchesFilter(metadata, options.service)) continue

    const sourceDbName = metadata.databaseName
    const sourceEnvironment = metadata.environment || options.sourceEnvironment
    const targetDbName = resolveTargetDatabaseName(sourceDbName, sourceEnvironment, options.targetEnvironment)

    services.push({
      name: sourceDbName,
      sourceDbName,
      targetDbName,
      metadata
    })
  }

  if (options.service && !services.length) {
    throw new Error(`No metadata found matching service: ${options.service}`)
  }

  if (options.services?.length) {
    const explicitServices = []

    for (const service of options.services) {
      const sourceDbName = service.sourceDbName || service.name
      const targetDbName = service.targetDbName || resolveTargetDatabaseName(sourceDbName, options.sourceEnvironment, options.targetEnvironment)
      const metadataFile = metadataFiles.find(filePath => path.basename(filePath).startsWith(`${sourceDbName}-`))
      const metadata = metadataFile ? await readMetadataFile(metadataFile) : null

      explicitServices.push({
        name: sourceDbName,
        sourceDbName,
        targetDbName,
        metadata
      })
    }

    return explicitServices
  }

  return services
}

async function queryExistingTables (connection, tableNames) {
  if (!tableNames.length) return new Set()

  const placeholders = tableNames.map((_, index) => `$${index + 1}`).join(',')
  const result = await connection.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'
       AND lower(table_name) = ANY (ARRAY[${placeholders}]::text[])`,
    tableNames.map(tableName => tableName.toLowerCase())
  )

  return new Set(result.rows.map(row => row.table_name))
}

async function queryTableStats (connection, tableNames) {
  if (!tableNames.length) return {}

  const stats = {}

  for (const tableName of tableNames) {
    try {
      const safeTable = tableName.replace(/"/g, '""')
      const result = await connection.query(
        `SELECT COUNT(*)::int AS row_count,
                pg_total_relation_size('public."${safeTable}"') AS total_bytes
         FROM public."${safeTable}"`
      )

      stats[tableName] = {
        row_count: Number(result.rows[0]?.row_count || 0),
        total_bytes: Number(result.rows[0]?.total_bytes || 0)
      }
    } catch (error) {
      stats[tableName] = {
        row_count: null,
        total_bytes: null,
        error: error.message
      }
    }
  }

  return stats
}

function formatBytes (bytes) {
  if (bytes == null || Number.isNaN(Number(bytes))) return 'n/a'
  const value = Number(bytes)
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function printComparisonRow (tableName, sourceReport, targetReport, includeStats) {
  const sourceRowCount = sourceReport?.row_count == null ? 'n/a' : sourceReport.row_count.toLocaleString()
  const targetRowCount = targetReport?.row_count == null ? 'n/a' : targetReport.row_count.toLocaleString()
  const matchMarker = sourceReport?.row_count === targetReport?.row_count ? '✓' : '✗'

  if (includeStats) {
    const sourceSize = sourceReport?.total_bytes == null ? 'n/a' : formatBytes(sourceReport.total_bytes)
    const targetSize = targetReport?.total_bytes == null ? 'n/a' : formatBytes(targetReport.total_bytes)
    console.log(`${tableName.padEnd(30)} | ${String(sourceRowCount).padEnd(12)} | ${String(targetRowCount).padEnd(12)} | ${matchMarker.padEnd(5)} | ${sourceSize.padEnd(10)} | ${targetSize}`)
  } else {
    console.log(`${tableName.padEnd(30)} | ${String(sourceRowCount).padEnd(12)} | ${String(targetRowCount).padEnd(12)} | ${matchMarker}`)
  }
}

async function compareService (service, options) {
  const { sourceEnvironment, targetEnvironment, limit, includeStats } = options
  const { sourceDbName, targetDbName, metadata } = service

  console.log(`\n=== ${service.name} ===`)
  console.log(`Source DB: ${sourceDbName}`)
  console.log(`Target DB: ${targetDbName}`)

  const tableNames = metadata.tables
  if (!tableNames.length) {
    console.log('No metadata tables found for this service.')
    return { service: service.name, checked: 0, onlyInSource: 0, onlyInTarget: 0, inBoth: 0, missingOnBoth: 0 }
  }

  const respectedTables = tableNames.slice(0, limit || tableNames.length)

  const sourceConnection = await createConnection(sourceDbName, { environment: sourceEnvironment })
  const targetConnection = await createConnection(targetDbName, { environment: targetEnvironment })

  try {
    const sourcePresent = await queryExistingTables(sourceConnection, respectedTables)
    const targetPresent = await queryExistingTables(targetConnection, respectedTables)

    const onlyInSource = respectedTables.filter(tableName => sourcePresent.has(tableName) && !targetPresent.has(tableName))
    const onlyInTarget = respectedTables.filter(tableName => !sourcePresent.has(tableName) && targetPresent.has(tableName))
    const inBoth = respectedTables.filter(tableName => sourcePresent.has(tableName) && targetPresent.has(tableName))
    const missingOnBoth = respectedTables.filter(tableName => !sourcePresent.has(tableName) && !targetPresent.has(tableName))

    console.log(`Tables checked: ${respectedTables.length}`)
    console.log(`Present in source/target: ${inBoth.length}`)
    console.log(`Only in source: ${onlyInSource.length}`)
    console.log(`Only in target: ${onlyInTarget.length}`)
    console.log(`Missing on both: ${missingOnBoth.length}`)

    if (onlyInSource.length) {
      console.log('\nOnly in source:')
      onlyInSource.forEach(tableName => console.log(`  - ${tableName}`))
    }

    if (onlyInTarget.length) {
      console.log('\nOnly in target:')
      onlyInTarget.forEach(tableName => console.log(`  - ${tableName}`))
    }

    if (missingOnBoth.length) {
      console.log('\nMissing on both:')
      missingOnBoth.forEach(tableName => console.log(`  - ${tableName}`))
    }

    if (inBoth.length) {
      console.log('\nTable comparison:')
      if (includeStats) {
        console.log('table                         | source rows  | target rows  | match | source size | target size')
        console.log('------------------------------|--------------|--------------|-------|-------------|------------')
      } else {
        console.log('table                         | source rows  | target rows  | match')
        console.log('------------------------------|--------------|--------------|-------')
      }

      const sourceStats = await queryTableStats(sourceConnection, inBoth)
      const targetStats = await queryTableStats(targetConnection, inBoth)

      for (const tableName of inBoth) {
        printComparisonRow(
          tableName,
          sourceStats[tableName] || { row_count: null, total_bytes: null },
          targetStats[tableName] || { row_count: null, total_bytes: null },
          includeStats
        )
      }
    }

    if (includeStats && inBoth.length) {
      console.log('\nStats for tables present in both databases:')
      console.log('DB          | table                         | rows          | size')
      console.log('------------|------------------------------|---------------|----------------')

      const sourceStats = await queryTableStats(sourceConnection, inBoth)
      const targetStats = await queryTableStats(targetConnection, inBoth)

      for (const tableName of inBoth) {
        printSummaryRow('source', tableName, sourceStats[tableName] || { row_count: null, total_bytes: null })
        printSummaryRow('target', tableName, targetStats[tableName] || { row_count: null, total_bytes: null })
      }
    }

    return {
      service: service.name,
      checked: respectedTables.length,
      onlyInSource: onlyInSource.length,
      onlyInTarget: onlyInTarget.length,
      inBoth: inBoth.length,
      missingOnBoth: missingOnBoth.length
    }
  } finally {
    await sourceConnection?.pool?.end()
    await targetConnection?.pool?.end()
  }
}

async function run () {
  const options = parseArgs()

  if (options.help) {
    console.log('Usage: node metadata-table-compare.js [options]\n\n' + [
      '--service <name>              single service to compare',
      '--services-file <path>        JSON file with a "services" array',
      '--source-environment <env>    default: config.sourceEnvironment',
      '--target-environment <env>    default: config.targetEnvironment',
      '--include-stats               include table size alongside row counts',
      '--limit <n>                   only check first n tables',
      '--metadata-dir <dir>          directory containing saved metadata files'
    ].join('\n'))
    process.exit(0)
  }

  const services = await resolveServices(options)
  if (!services.length) {
    throw new Error('No services found to compare. Use --service, --services-file, or ensure metadata files exist.')
  }

  console.log(`Source environment: ${options.sourceEnvironment}`)
  console.log(`Target environment: ${options.targetEnvironment}`)
  console.log(`Services: ${services.length}`)
  console.log(`Services: ${services.map(s => s.name).join(', ')}`)

  const summary = []
  for (const service of services) {
    const result = await compareService(service, options)
    summary.push(result)
  }

  console.log('\n=== Summary ===')
  console.log('Service                            | checked | in both | only source | only target | missing both')
  console.log('-----------------------------------|---------|---------|-------------|-------------|-------------')
  for (const result of summary) {
    console.log(
      `${result.service.padEnd(34)} | ${String(result.checked).padEnd(7)} | ${String(result.inBoth).padEnd(7)} | ${String(result.onlyInSource).padEnd(11)} | ${String(result.onlyInTarget).padEnd(11)} | ${result.missingOnBoth}`
    )
  }
}

run().catch(error => {
  console.error('Metadata table comparison failed:')
  console.error(error)
  process.exit(1)
})
