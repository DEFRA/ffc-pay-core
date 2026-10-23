const { spawn } = require('child_process')
const path = require('path')
const { services } = require('../config/services')

const DATA_RECOVERY_DIR = path.resolve(__dirname, '..', '..')

function parseArgs () {
  const args = process.argv.slice(2)
  const options = { dryRun: false }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node tools/pull-all-services.js [--dry-run]')
      console.log('Runs the pull step for all configured services in order.')
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

async function run () {
  const options = parseArgs()
  const extraArgs = options.dryRun ? ['--dry-run'] : []

  for (const service of services) {
    console.log('\n========================================')
    console.log(`Pulling service: ${service.name}`)
    console.log('========================================')
    await runCommand(service.pullCommand, extraArgs)
  }

  console.log('\n========================================')
  console.log('Pull complete for all services.')
  console.log('========================================')
}

run().catch(error => {
  console.error('Failed to pull all services:', error.message)
  process.exit(1)
})
