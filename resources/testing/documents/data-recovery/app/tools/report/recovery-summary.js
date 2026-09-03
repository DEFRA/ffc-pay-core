const { createLocalConnection } = require('../../database/local-db-connection')
const { createLocalRecoveryDb } = require('../../create-local-db')
const { services } = require('../../config/services')
const payProcessing = require('../../config/pay-processing')
const payInjection = require('../../config/pay-injection')
const payRequestEditor = require('../../config/pay-request-editor')
const paySubmission = require('../../config/pay-submission')
const payTracking = require('../../config/pay-tracking')
const eventHub = require('../../config/event-hub')

const SERVICE_CONFIGS = {
  'ffc-pay-processing': payProcessing,
  'ffc-pay-injection': payInjection,
  'ffc-pay-request-editor': payRequestEditor,
  'ffc-pay-submission': paySubmission,
  'ffc-pay-tracking': payTracking,
  'ffc-pay-event-hub': eventHub
}

function parseArgs () {
  const args = process.argv.slice(2)
  const options = { service: null }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--service' || arg === '-s') {
      options.service = args[++i]
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node tools/report/recovery-summary.js [--service <name>]')
      console.log('')
      console.log('Prints local verification queue summaries and recovered row counts.')
      console.log('This is a quick read-only report based on the flags set by the flag scripts.')
      process.exit(0)
    }
  }

  return options
}

async function ensureLocalRecoveryDb () {
  try {
    const connection = await createLocalConnection({ applicationName: 'ffc_pay_summary_probe' })
    await connection.close()
  } catch (error) {
    console.log('Local recovery database is not available; running create-local-db.js first...')
    await createLocalRecoveryDb()
  }
}

async function tableExists (connection, tableName) {
  const { rows } = await connection.query(
    'SELECT 1 FROM information_schema.tables WHERE table_schema = \'public\' AND table_name = $1',
    [tableName]
  )
  return rows.length > 0
}

async function getFlagColumns (localConnection, queueTable, configuredFlagColumns) {
  const { rows } = await localConnection.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
      AND data_type = 'boolean'
      AND column_name LIKE 'foundIn%'
    ORDER BY ordinal_position
  `, [queueTable])

  const existingColumns = rows.map(r => r.column_name)
  const configuredSet = new Set(configuredFlagColumns || [])

  for (const column of existingColumns) {
    if (!configuredSet.has(column)) {
      await localConnection.query(`
        ALTER TABLE public."${queueTable}"
        DROP COLUMN IF EXISTS "${column}"
      `)
      console.log(`  Dropped obsolete flag column "${column}" from ${queueTable}`)
    }
  }

  return existingColumns.filter(col => configuredSet.has(col))
}

async function getQueueSummary (localConnection, queueTable, configuredFlagColumns) {
  const exists = await tableExists(localConnection, queueTable)
  if (!exists) {
    return null
  }

  const flagColumns = await getFlagColumns(localConnection, queueTable, configuredFlagColumns)
  const flagSelects = flagColumns.map(col => `COUNT(*) FILTER (WHERE "${col}") AS "${col}"`).join(', ')
  const { rows } = await localConnection.query(`
    SELECT
      COUNT(*) AS total
      ${flagSelects ? `, ${flagSelects}` : ''}
    FROM public."${queueTable}"
  `)
  return { ...rows[0], flagColumns }
}

async function getLocalRowCount (localConnection, tableName) {
  const exists = await tableExists(localConnection, tableName)
  if (!exists) {
    return null
  }
  const { rows } = await localConnection.query(`SELECT COUNT(*)::int AS count FROM public."${tableName}"`)
  return rows[0].count
}

async function printServiceSummary (localConnection, service) {
  const config = SERVICE_CONFIGS[service.name]
  const configuredFlagColumns = config?.QUEUE_TABLE?.flagColumns
  const summary = await getQueueSummary(localConnection, service.queueTable, configuredFlagColumns)

  console.log(`\n=== ${service.name} queue summary ===`)

  if (!summary) {
    console.log(`  Queue ${service.queueTable} not found locally`)
    return
  }

  console.log(`  Total IDs: ${Number(summary.total).toLocaleString()}`)

  for (const col of summary.flagColumns) {
    const value = summary[col] ?? 0
    console.log(`  ${col.padEnd(35)} ${Number(value).toLocaleString()} IDs`)
  }

  await printLocalRecoveredRows(localConnection, service)
}

async function printLocalRecoveredRows (localConnection, service) {
  const config = SERVICE_CONFIGS[service.name]
  if (!config) {
    return
  }

  const allTables = [
    ...(config.TABLES || []),
    ...(config.DEPENDENT_TABLES || []),
    ...(config.PARENT_TABLE ? [config.PARENT_TABLE] : [])
  ]

  const tablesWithCounts = []
  for (const table of allTables) {
    const localName = table.localName || `${service.localPrefix}_${table.name}`
    const count = await getLocalRowCount(localConnection, localName)
    if (count !== null) {
      tablesWithCounts.push({ name: table.name, localName, count })
    }
  }

  if (tablesWithCounts.length === 0) {
    return
  }

  console.log(`\n=== ${service.name} local recovered rows ===`)
  for (const { name, count } of tablesWithCounts) {
    console.log(`  ${name.padEnd(35)} ${Number(count).toLocaleString()} rows`)
  }
}

async function run () {
  const options = parseArgs()

  await ensureLocalRecoveryDb()

  let localConnection

  try {
    localConnection = await createLocalConnection({ applicationName: 'ffc_pay_recovery_summary' })

    const targetServices = options.service
      ? services.filter(s => s.name === options.service)
      : services

    for (const service of targetServices) {
      await printServiceSummary(localConnection, service)
    }

    console.log('\n=== Summary complete ===')
  } catch (error) {
    console.error('Failed to generate recovery summary:', error.message)
    process.exit(1)
  } finally {
    if (localConnection) {
      await localConnection.close()
    }
  }
}

run().catch(error => {
  console.error('Failed to generate recovery summary:', error.message)
  process.exit(1)
})
