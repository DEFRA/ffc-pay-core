const dumpFiles = require('./database/dump-all-test-tables')
const transformFiles = require('./transform/transform-all')
const upload = require('./upload/upload-to-dev')
const readline = require('readline')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run') || process.env.DRY_RUN === 'true'

function promptContinue(message = 'Continue to next step? (y/n): ') {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(message, (answer) => {
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

const delinkedDataTransformer = async (dryRun = false) => {
  try {
    console.log('Starting delinked data transformer process...')
    if (dryRun) console.log('🔍 DRY RUN MODE ENABLED')

    if (!await safeRun(() => dumpFiles.dumpAllTestTables(dryRun), 'dumping test tables')) return
    if (!(await promptContinue('Dump complete. Continue to transform? (y/n): '))) return

    if (!await safeRun(() => transformFiles.transformAll(dryRun), 'transforming files')) return
    if (!(await promptContinue('Transform complete. Continue to upload? (y/n): '))) return

    if (!await safeRun(() => upload.uploadToDev(dryRun), 'uploading to DEV')) return

    console.log('Delinked data transformer process completed successfully.')
  } catch (error) {
    console.error('Error during delinked data transformation:', error)
  }
}

module.exports = {
  delinkedDataTransformer
}

// Allow direct execution
if (require.main === module) {
  delinkedDataTransformer(dryRun)
    .then(success => process.exit(success ? 0 : 1))
    .catch(error => {
      logError(`ETL process failed: ${error}`)
      process.exit(1)
    })
}