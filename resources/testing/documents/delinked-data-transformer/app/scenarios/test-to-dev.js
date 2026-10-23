const dumpFiles = require('../database/dump-all-test-tables')
const transformFiles = require('../transform/transform-all')
const upload = require('../upload/upload-to-dev')
const dummyData = require('../../dummy-data-creation/create-dummy-file')
const { testConnection } = require('../database/db-connection')
const readline = require('readline')

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

async function runScenario (options = {}) {
  const {
    dryRun = false,
    testConnection: connectionCheck = false,
    sourceEnvironment = 'test',
    targetEnvironment = 'dev'
  } = options

  console.log('Running scenario: test-to-dev')
  console.log({ sourceEnvironment, targetEnvironment, dryRun, connectionCheck })

  if (connectionCheck) {
    await testBothConnections(sourceEnvironment, targetEnvironment)
  }

  if (dryRun) {
    console.log('Running dry-run pipeline for scenario: test-to-dev')
    await dumpFiles.dumpAllTestTables(true)
    await transformFiles.transformAll(true)
    await upload.uploadToDev('all', true, { sourceEnvironment, targetEnvironment })
    return {
      scenario: 'test-to-dev',
      sourceEnvironment,
      targetEnvironment,
      dryRun,
      testConnection: connectionCheck,
      status: 'dry-run-ok'
    }
  }

  console.log('Starting delinked data transformer process...')
  console.log('This process will run through the following steps:\n' +
    '1. Create dummy data file if required\n' +
    '2. Backup TEST database\n' +
    '3. Create dummy data records\n' +
    '4. Dump test tables\n' +
    '5. Transform files\n' +
    '6. Upload to DEV environment\n')

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
    if (!await safeRun(() => dumpFiles.dumpAllTestTables(false), 'dumping test tables')) return { scenario: 'test-to-dev', status: 'failed' }
  } else {
    console.log('Skipping dump step.')
  }

  if (await promptContinue('Run transform step? (y/n): ')) {
    if (!await safeRun(() => transformFiles.transformAll(false), 'transforming files')) return { scenario: 'test-to-dev', status: 'failed' }
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

  return {
    scenario: 'test-to-dev',
    sourceEnvironment,
    targetEnvironment,
    dryRun,
    testConnection: connectionCheck,
    status: 'completed'
  }
}

module.exports = {
  runScenario
}
