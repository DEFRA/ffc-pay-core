const { spawn } = require('child_process')
const path = require('path')
const { services } = require('../config/services')
const { createLocalConnection } = require('../database/local-db-connection')
const { createLocalRecoveryDb } = require('../create-local-db')

const DATA_RECOVERY_DIR = path.resolve(__dirname, '..', '..')

function parseArgs () {
  const args = process.argv.slice(2)
  const options = { dryRun: false }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node tools/flag-all-services.js [--dry-run]')
      console.log('Runs the flag step for all configured services in order.')
      process.exit(0)
    }
  }

  return options
}

function runCommand (command, args) {
  return new Promise((resolve, reject) => {
    const [cmd, ...cmdArgs] = command.split(' ')
    const child = spawn(cmd, [...cmdArgs, ...args], {
      cwd: DATA_RECOVERY_DIR,
      stdio: 'inherit'
    })

    child.on('close', code => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Command failed with exit code ${code}: ${command}`))
      }
    })

    child.on('error', error => {
      reject(new Error(`Failed to start command ${command}: ${error.message}`))
    })
  })
}

async function getQueueSummary (localConnection, queueTable) {
  try {
    const { rows } = await localConnection.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'PENDING') AS pending,
        COUNT(*) FILTER (WHERE status = 'VERIFIED') AS verified,
        COUNT(*) FILTER (WHERE status = 'REJECTED') AS rejected,
        COUNT(*) FILTER (WHERE status = 'IN_PROGRESS') AS in_progress
      FROM public."${queueTable}"
    `)
    return rows[0]
  } catch (error) {
    return { total: 0, pending: 0, verified: 0, rejected: 0, in_progress: 0, error: error.message }
  }
}

async function tableExists (localConnection, tableName) {
  const { rows } = await localConnection.query(
    'SELECT 1 FROM information_schema.tables WHERE table_schema = \'public\' AND table_name = $1',
    [tableName]
  )
  return rows.length > 0
}

async function tableHasRows (localConnection, tableName) {
  const { rows } = await localConnection.query(
    `SELECT EXISTS (SELECT 1 FROM public."${tableName}" LIMIT 1) AS has_rows`
  )
  return rows[0].has_rows === true
}

async function prerequisiteSatisfied (localConnection, prerequisite) {
  const checkTables = prerequisite.checkTables || [prerequisite.checkTable]
  for (const tableName of checkTables) {
    const exists = await tableExists(localConnection, tableName)
    const hasRows = exists && await tableHasRows(localConnection, tableName)
    if (!exists || !hasRows) {
      return { satisfied: false, tableName }
    }
  }
  return { satisfied: true }
}

async function ensurePrerequisites (service, localConnection, dryRun) {
  const prerequisites = service.flagPrerequisites || []

  for (const prerequisite of prerequisites) {
    const { satisfied, tableName } = await prerequisiteSatisfied(localConnection, prerequisite)
    if (satisfied) {
      console.log(`  Prerequisite satisfied: ${prerequisite.name} already present locally`)
      continue
    }

    if (dryRun) {
      console.log(`  Dry run: would run prerequisite ${prerequisite.name} (${prerequisite.command})`)
      continue
    }

    if (tableName) {
      console.log(`  Prerequisite table ${tableName} is missing or empty`)
    }

    console.log('\n----------------------------------------')
    console.log(`Pulling prerequisite data: ${prerequisite.name}`)
    console.log('----------------------------------------')
    await runCommand(prerequisite.command, [])
  }
}

async function ensureLocalRecoveryDb () {
  try {
    const connection = await createLocalConnection({ applicationName: 'ffc_pay_flag_all_probe' })
    await connection.close()
    console.log('Local recovery database is already running.')
  } catch (error) {
    console.log('Local recovery database is not available; running create-local-db.js first...')
    await createLocalRecoveryDb()
  }
}

async function run () {
  const options = parseArgs()
  const extraArgs = options.dryRun ? ['--dry-run'] : []

  await ensureLocalRecoveryDb()

  let localConnection
  try {
    localConnection = await createLocalConnection({ applicationName: 'ffc_pay_flag_all_orchestrator' })

    for (const service of services) {
      console.log('\n========================================')
      console.log(`Flagging service: ${service.name}`)
      console.log('========================================')

      await ensurePrerequisites(service, localConnection, options.dryRun)
      await runCommand(service.flagCommand, extraArgs)

      if (service.pullAfterFlag && !options.dryRun) {
        console.log('\n----------------------------------------')
        console.log(`Pulling data for ${service.name} after flag step`)
        console.log('----------------------------------------')
        await runCommand(service.pullCommand, extraArgs)
      }
    }

    console.log('\n========================================')
    console.log('Flagging complete. Fetching summaries...')
    console.log('========================================')

    for (const service of services) {
      const summary = await getQueueSummary(localConnection, service.queueTable)
      console.log(`\n${service.name} (${service.queueTable}):`)
      console.log(`  Total:       ${summary.total}`)
    }
  } catch (error) {
    console.error('Failed to flag all services:', error.message)
    process.exit(1)
  } finally {
    if (localConnection) {
      await localConnection.close()
    }
  }
}

run().catch(error => {
  console.error('Failed to flag all services:', error.message)
  process.exit(1)
})
