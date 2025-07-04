const dumpFiles = require('./database/dump-all-test-tables')
const transformFiles = require('./transform/transform-all')
const upload = require('./upload/upload-to-dev')
const readline = require('readline')

function promptContinue(message = 'Continue to next step? (y/n): ') {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(message, (answer) => {
      rl.close()
      resolve(answer.trim().toLowerCase() === 'y')
    })
  })
}

function promptSelectUploadType() {
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

function promptDryRun() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question('Run as dry-run first? (y/n): ', (answer) => {
      rl.close()
      resolve(answer.trim().toLowerCase() === 'y')
    })
  })
}

async function safeRun(fn, description) {
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

const delinkedDataTransformer = async () => {
  try {
    console.log('Starting delinked data transformer process...')

    // DUMP
    if (await promptContinue('Run dump step? (y/n): ')) {
      if (!await safeRun(() => dumpFiles.dumpAllTestTables(false), 'dumping test tables')) return
    } else {
      console.log('Skipping dump step.')
    }

    // TRANSFORM
    if (await promptContinue('Run transform step? (y/n): ')) {
      if (!await safeRun(() => transformFiles.transformAll(false), 'transforming files')) return
    } else {
      console.log('Skipping transform step.')
    }

    // UPLOAD
    let done = false
    while (!done) {
      const uploadType = await promptSelectUploadType()
      if (uploadType === 'none') {
        console.log('No upload selected. Process complete.')
        break
      }

      // Ask if user wants a dry run first
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

      // Ask if they want to upload another type
      const again = await promptContinue('Would you like to run another upload? (y/n): ')
      if (!again) {
        console.log('Process complete.')
        done = true
      }
    }
  } catch (error) {
    console.error('Error during delinked data transformation:', error)
  }
}

module.exports = {
  delinkedDataTransformer
}

// Allow direct execution
if (require.main === module) {
  delinkedDataTransformer()
    .then(success => process.exit(success ? 0 : 1))
    .catch(error => {
      console.error(`ETL process failed: ${error}`)
      process.exit(1)
    })
}