// This only needs to run if you have partly populated data for paymentRequestIds but need to pull the dependent tables (completedInvoiceLines and outbox) from the hosted recovery database.
// It will create the local tables if they don't exist, and will not delete any existing data.

const { createRecoveryConnection } = require('../../database/recovery-db-connection')
const { createLocalConnection } = require('../../database/local-db-connection')
const { ensureLocalTable } = require('../../services/schema-service')
const { fetchRowsBySingleKey, insertRows } = require('../../services/pull-service')
const payProcessing = require('../../config/pay-processing')

const { HOSTED_DATABASE, LOCAL_QUEUE_TABLE, TABLES, DEPENDENT_TABLES } = payProcessing

function parseArgs () {
  const args = process.argv.slice(2)
  const options = { dryRun: false, limit: 0 }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--limit') {
      options.limit = Number(args[++i])
      if (!Number.isFinite(options.limit) || options.limit <= 0) {
        throw new Error('--limit must be a positive number')
      }
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node tools/pull/pull-pay-processing-dependent-data.js [--dry-run] [--limit N]')
      console.log('Pulls completedInvoiceLines and outbox rows based on locally stored completedPaymentRequestIds')
      console.log('--limit N: process only the first N completed payment request IDs (for testing)')
      process.exit(0)
    }
  }

  return options
}

async function getLocalCompletedPaymentRequestIds (localConnection, limit) {
  const parentTable = TABLES.find(t => t.name === 'completedPaymentRequests')
  let sql = `SELECT DISTINCT "completedPaymentRequestId" FROM public."${parentTable.localName}" ORDER BY "completedPaymentRequestId"`
  if (limit > 0) {
    sql += ` LIMIT ${limit}`
  }
  const { rows } = await localConnection.query(sql)
  return rows.map(row => row.completedPaymentRequestId)
}

async function updateQueueFlagsForDependentTable (localConnection, dependentConfig) {
  const parentTable = TABLES.find(t => t.name === 'completedPaymentRequests')
  const result = await localConnection.query(
    `
    UPDATE public."${LOCAL_QUEUE_TABLE}" q
    SET "${dependentConfig.flagColumn}" = true,
        "updatedAt" = CURRENT_TIMESTAMP
    FROM public."${parentTable.localName}" cpr
    JOIN public."${dependentConfig.localName}" dt
      ON dt."${dependentConfig.foreignKey}" = cpr."completedPaymentRequestId"
    WHERE q."paymentRequestId" = cpr."paymentRequestId"
      AND q."${dependentConfig.flagColumn}" = false
    `
  )
  return result.rowCount
}

async function copyDependentTables (hostedConnection, localConnection, options) {
  const parentIds = await getLocalCompletedPaymentRequestIds(localConnection, options.limit)
  console.log(`Found ${parentIds.length} local completedPaymentRequestIds to use for dependent-table lookup`)

  if (parentIds.length === 0) {
    console.log('No completedPaymentRequests pulled yet; skipping dependent tables')
    return
  }

  for (const dependentConfig of DEPENDENT_TABLES) {
    console.log(`\nDependent table: ${dependentConfig.name}`)
    const { hostedColumns, localColumns, primaryKey } = await ensureLocalTable(localConnection, hostedConnection, dependentConfig.localName, dependentConfig.name)
    const insertColumns = localColumns.filter(c => hostedColumns.includes(c))

    if (options.dryRun) {
      console.log(`  Dry run: would fetch rows from hosted public."${dependentConfig.name}"`)
      continue
    }

    const rows = await fetchRowsBySingleKey(hostedConnection, dependentConfig.name, hostedColumns, dependentConfig.foreignKey, parentIds)

    if (rows.length > 0) {
      const inserted = await insertRows(localConnection, dependentConfig.localName, insertColumns, primaryKey, rows)
      console.log(`  ${inserted} rows copied`)
    } else {
      console.log('  0 rows found in hosted')
    }

    const flaggedCount = await updateQueueFlagsForDependentTable(localConnection, dependentConfig)
    console.log(`${dependentConfig.name}: finished, ${flaggedCount} queue entries flagged`)
  }
}

async function run () {
  const options = parseArgs()

  let hostedConnection
  let localConnection

  try {
    console.log(`Connecting to hosted ${HOSTED_DATABASE} database (read-only)...`)
    hostedConnection = await createRecoveryConnection({ database: HOSTED_DATABASE, applicationName: 'ffc_pay_recovery_dependent_pull' })

    console.log('Connecting to local recovery database (write)...')
    localConnection = await createLocalConnection({ applicationName: 'ffc_pay_recovery_dependent_pull' })

    await copyDependentTables(hostedConnection, localConnection, options)

    console.log('\nDependent data pull complete.')
  } catch (error) {
    console.error('Failed to pull dependent recovery data:', error.message)
    process.exit(1)
  } finally {
    if (hostedConnection) {
      await hostedConnection.close()
    }
    if (localConnection) {
      await localConnection.close()
    }
  }
}

run()
