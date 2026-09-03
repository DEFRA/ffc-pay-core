const dumpFiles = require('./database/dump-all-test-tables')
const transformFiles = require('./transform/transform-all')
const upload = require('./upload/upload-to-dev')
const dummyData = require('../dummy-data-creation/create-dummy-file')
const appConfig = require('./config')
const scenarios = require('./config/scenarios')
const { testConnection } = require('./database/db-connection')
const { runScenario } = require('./scenarios')
const readline = require('readline')

function parseCliArgs (argv = process.argv.slice(2)) {
  const args = {
    scenario: appConfig.scenario,
    dryRun: false,
    testConnection: false,
    continueOnError: false,
    direct: false,
    tableByTable: false,
    singleTransaction: true,
    resume: false,
    resetCheckpoints: false
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--scenario') {
      args.scenario = argv[++i]
    } else if (arg === '--dry-run') {
      args.dryRun = true
    } else if (arg === '--test-connection') {
      args.testConnection = true
    } else if (arg === '--continue-on-error') {
      args.continueOnError = true
    } else if (arg === '--direct') {
      args.direct = true
    } else if (arg === '--table-by-table') {
      args.tableByTable = true
    } else if (arg === '--no-single-transaction') {
      args.singleTransaction = false
    } else if (arg === '--resume') {
      args.resume = true
    } else if (arg === '--reset-checkpoints') {
      args.resetCheckpoints = true
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    }
  }

  return args
}

function promptContinue (message = 'Continue to next step? (y/n): ', defaultValue = 'y') {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(`${message} (default: ${defaultValue}): `, (answer) => {
      rl.close()
      const response = answer.trim().toLowerCase()
      if (response === '') {
        resolve(defaultValue.toLowerCase() === 'y')
      } else {
        resolve(response === 'y')
      }
    })
  })
}

function promptInput (message, defaultValue) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(`${message} (default: ${defaultValue}): `, (answer) => {
      rl.close()
      resolve(answer.trim() === '' ? defaultValue : answer.trim())
    })
  })
}

function promptSelectUploadType () {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(
      '\nWhich upload would you like to run?\n' +
      '1. ffc-pay only\n' +
      '2. ffc-doc only\n' +
      '3. all (both)\n' +
      '4. none (finish)\n' +
      'Enter choice (1/2/3/4): ',
      (answer) => {
        rl.close()
        const choice = answer.trim()
        if (choice === '1') resolve('ffc-pay')
        else if (choice === '2') resolve('ffc-doc')
        else if (choice === '3') resolve('all')
        else resolve('none')
      }
    )
  })
}

function promptDryRun () {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question('Run as dry-run first? (y/n): ', (answer) => {
      rl.close()
      resolve(answer.trim().toLowerCase() === 'y')
    })
  })
}

async function safeRun (fn, description) {
  try {
    await fn()
    return true
  } catch (err) {
    console.error(`❌ Error during ${description}:`, err)
    const retry = await promptContinue(`Retry ${description}? (y/n): `)
    if (retry) return safeRun(fn, description)
    return false
  }
}

async function testBothConnections (sourceEnvironment, targetEnvironment) {
  console.log(`Testing connection to source environment: ${sourceEnvironment}`)
  const sourceResult = await testConnection(sourceEnvironment, 'postgres')
  console.log(`Source connection OK: ${sourceResult.host}:${sourceResult.port}/${sourceResult.database}`)

  console.log(`Testing connection to target environment: ${targetEnvironment}`)
  const targetResult = await testConnection(targetEnvironment, 'postgres')
  console.log(`Target connection OK: ${targetResult.host}:${targetResult.port}/${targetResult.database}`)

  return { sourceResult, targetResult }
}

async function executeScenario (scenarioName = appConfig.scenario, options = {}) {
  const selectedScenario = scenarios[scenarioName] || {}

  const preferredSourceEnvironment = options.sourceEnvironment || selectedScenario.sourceEnvironment || appConfig.sourceEnvironment
  const preferredTargetEnvironment = options.targetEnvironment || selectedScenario.targetEnvironment || appConfig.targetEnvironment

  const dryRun = options.dryRun !== undefined ? options.dryRun : false
  const runConnectionCheck = options.testConnection !== undefined ? options.testConnection : false
  const continueOnError = options.continueOnError !== undefined ? options.continueOnError : false
  const tableByTable = options.tableByTable !== undefined ? options.tableByTable : false
  const singleTransaction = options.singleTransaction !== undefined ? options.singleTransaction : true
  const resume = options.resume !== undefined ? options.resume : false
  const resetCheckpoints = options.resetCheckpoints !== undefined ? options.resetCheckpoints : false

  let sourceEnvironment = preferredSourceEnvironment
  let targetEnvironment = preferredTargetEnvironment

  if (scenarioName === 'test-to-dev') {
    sourceEnvironment = 'test'
    targetEnvironment = 'dev'
  }

  if (scenarioName === 'prd-to-pre') {
    const allowedSourceEnvironments = new Set(['prd', 'recovery', 'test'])
    const allowedTargetEnvironments = new Set(['pre', 'test', 'dev'])

    if (!allowedSourceEnvironments.has(sourceEnvironment)) {
      throw new Error(`prd-to-pre source environment must be one of: ${[...allowedSourceEnvironments].join(', ')}`)
    }

    if (!allowedTargetEnvironments.has(targetEnvironment)) {
      throw new Error(`prd-to-pre target environment must be one of: ${[...allowedTargetEnvironments].join(', ')}`)
    }
  }

  console.log(`Scenario: ${scenarioName}`)
  console.log(`Source environment: ${sourceEnvironment}`)
  console.log(`Target environment: ${targetEnvironment}`)
  console.log(`Dry run: ${dryRun}`)

  if (runConnectionCheck) {
    await testBothConnections(sourceEnvironment, targetEnvironment)
  }

  if (scenarioName === 'prd-to-pre') {
    const { buildServiceManifest } = require('./database/service-manifest')
    const { runSequentialTransfers } = require('./database/sequential-transfer-runner')
    const manifest = buildServiceManifest(sourceEnvironment, targetEnvironment)

    return runSequentialTransfers(manifest.services, {
      sourceEnvironment,
      targetEnvironment,
      dryRun,
      continueOnError,
      tableByTable,
      singleTransaction,
      resume,
      resetCheckpoints
    })
  }

  const { runScenario: runTestToDevScenario } = require('./scenarios/test-to-dev')
  return runTestToDevScenario({
    dryRun,
    testConnection: runConnectionCheck,
    sourceEnvironment,
    targetEnvironment
  })
}

const delinkedDataTransformer = async () => {
  try {
    const cliArgs = parseCliArgs()
    if (cliArgs.help) {
      console.log('Usage: node app/index.js --scenario <test-to-dev|prd-to-pre|dev-to-test> [--dry-run] [--test-connection] [--continue-on-error] [--table-by-table] [--no-single-transaction] [--resume] [--reset-checkpoints]')
      return true
    }

    const scenarioName = cliArgs.scenario || appConfig.scenario || 'test-to-dev'
    const dryRun = cliArgs.dryRun
    const testConnectionRun = cliArgs.testConnection
    const continueOnError = cliArgs.continueOnError
    const tableByTable = cliArgs.tableByTable
    const singleTransaction = cliArgs.singleTransaction
    const resume = cliArgs.resume
    const resetCheckpoints = cliArgs.resetCheckpoints

    if (cliArgs.direct) {
      return await executeScenario(scenarioName, { dryRun, testConnection: testConnectionRun, continueOnError, tableByTable, singleTransaction, resume, resetCheckpoints })
    }

    console.log('Starting delinked data transformer process...')
    console.log('This process will run through the following steps:\n' +
      '1. Create dummy data file if required\n' +
      '2. Backup TEST database\n' +
      '3. Create dummy data records\n' +
      '4. Dump test tables\n' +
      '5. Transform files\n' +
      '6. Upload to DEV environment\n')

    // DUMMY DATA CREATION
    if (await promptContinue('Create dummy records file? (y/n): ')) {
      const recordCountInput = await promptInput('How many records to create?', '25000')
      const recordCount = parseInt(recordCountInput, 10)
      if (isNaN(recordCount) || recordCount <= 0) {
        console.log('Invalid record count, skipping dummy data creation.')
      } else {
        const separateFiles = false
        await safeRun(() => dummyData.generateSqlStatements(recordCount, separateFiles), `creating ${recordCount} dummy records`)
      }
    } else {
      console.log('Skipping dummy data creation.')
    }

    if (await promptContinue('Run dump step? (y/n): ')) {
      if (!await safeRun(() => dumpFiles.dumpAllTestTables(false), 'dumping test tables')) return
    } else {
      console.log('Skipping dump step.')
    }

    if (await promptContinue('Run transform step? (y/n): ')) {
      if (!await safeRun(() => transformFiles.transformAll(false), 'transforming files')) return
    } else {
      console.log('Skipping transform step.')
    }

    let done = false
    while (!done) {
      const uploadType = await promptSelectUploadType()
      if (uploadType === 'none') {
        console.log('No upload selected. Process complete.')
        break
      }

      const doDryRun = await promptDryRun()
      let uploadFn
      if (uploadType === 'ffc-pay') uploadFn = upload.uploadFfcPayToDev
      else if (uploadType === 'ffc-doc') uploadFn = upload.uploadFfcDocToDev
      else uploadFn = upload.uploadToDev

      if (doDryRun) {
        console.log(`\n--- DRY RUN: ${uploadType.toUpperCase()} ---`)
        await safeRun(() => uploadFn(true), `dry-run uploading ${uploadType.toUpperCase()} to DEV`)
        const liveRun = await promptContinue('Would you like to run a LIVE upload now? (y/n): ')
        if (liveRun) {
          console.log(`\n--- LIVE RUN: ${uploadType.toUpperCase()} ---`)
          await safeRun(() => uploadFn(false), `uploading ${uploadType.toUpperCase()} to DEV`)
        }
      } else {
        await safeRun(() => uploadFn(false), `uploading ${uploadType.toUpperCase()} to DEV`)
      }

      const again = await promptContinue('Would you like to run another upload? (y/n): ')
      if (!again) {
        console.log('Process complete.')
        done = true
      }
    }
    return true
  } catch (error) {
    console.error('Error during delinked data transformation:', error)
    return false
  }
}

module.exports = {
  delinkedDataTransformer
}

module.exports = {
  delinkedDataTransformer,
  runScenario,
  executeScenario,
  testBothConnections,
  parseCliArgs
}

// Allow direct execution
if (require.main === module) {
  const cliArgs = parseCliArgs()

  if (cliArgs.help) {
    console.log('Usage: node app/index.js --scenario <test-to-dev|prd-to-pre|dev-to-test> [--dry-run] [--test-connection] [--continue-on-error] [--direct] [--table-by-table] [--no-single-transaction] [--resume] [--reset-checkpoints]')
    process.exit(0)
  }

  const scenarioName = cliArgs.scenario || appConfig.scenario || 'test-to-dev'

  const run = cliArgs.direct
    ? executeScenario(scenarioName, {
      dryRun: cliArgs.dryRun,
      testConnection: cliArgs.testConnection,
      continueOnError: cliArgs.continueOnError,
      sourceEnvironment: cliArgs.sourceEnvironment,
      targetEnvironment: cliArgs.targetEnvironment,
      tableByTable: cliArgs.tableByTable,
      singleTransaction: cliArgs.singleTransaction,
      resume: cliArgs.resume,
      resetCheckpoints: cliArgs.resetCheckpoints
    })
    : delinkedDataTransformer()

  run
    .then(result => {
      const success = result === true || (result && typeof result === 'object' && result.success !== false)
      process.exit(success ? 0 : 1)
    })
    .catch(error => {
      console.error(`ETL process failed: ${error.message || error}`)
      process.exit(1)
    })
}
