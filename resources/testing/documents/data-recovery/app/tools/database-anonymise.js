#!/usr/bin/env node

const databaseRefresh = require('../config/database-refresh')
const { resolveTargetProfile } = require('../config/database-profiles')
const { buildDatabaseEnvironment } = require('./database-refresh-set')
const {
  assertAnonymisationTarget,
  describeAnonymisation,
  getAnonymisationConfirmation,
  anonymiseDatabase
} = require('../services/database-anonymisation-service')

function parseArgs (argv = process.argv.slice(2)) {
  const options = { databaseName: null, dryRun: false, confirmTarget: null, help: false }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--database' || argument === '--confirm-target') {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
      const key = argument === '--database' ? 'databaseName' : 'confirmTarget'
      if (options[key]) throw new Error(`${argument} may only be supplied once`)
      options[key] = value
    } else if (argument === '--dry-run') {
      options.dryRun = true
    } else if (argument === '--help' || argument === '-h') {
      options.help = true
    } else {
      throw new Error(`Unknown option "${argument}"`)
    }
  }
  if (options.help) return options
  if (!options.databaseName) throw new Error('Anonymisation requires --database <base-name>')
  if (options.dryRun && options.confirmTarget) throw new Error('Do not pass --confirm-target with --dry-run')
  if (!options.dryRun && !options.confirmTarget) throw new Error('Live anonymisation requires --confirm-target from a dry run')
  return options
}

function usage () {
  return [
    'Usage:',
    '  npm run database:anonymise -- --database <base-name> --dry-run',
    '  npm run database:anonymise -- --database <base-name> --confirm-target <confirmation>',
    '',
    'Updates an existing offline target only. TARGET_ENV and local targets use app/config/database-refresh.js.',
    'The target must have no other client connections. Only explicitly configured columns are changed.'
  ].join('\n')
}

async function anonymiseDatabaseTarget (options, dependencies = {}) {
  const config = options.refreshConfig || databaseRefresh
  const environment = buildDatabaseEnvironment(options.databaseName, 'target', options.environment || process.env, config)
  const target = resolveTargetProfile(options.databaseName, environment).config
  assertAnonymisationTarget(environment, target)
  const description = describeAnonymisation(options.databaseName)
  if (description.tables.length === 0) throw new Error(`No anonymisation mappings configured for ${options.databaseName}`)
  const confirmation = getAnonymisationConfirmation(target, description)
  if (!options.dryRun && options.confirmTarget !== confirmation) {
    throw new Error(`--confirm-target must exactly match the anonymisation dry-run token: ${confirmation}`)
  }
  const mask = dependencies.anonymiseDatabase || anonymiseDatabase
  const result = await mask({ serviceName: options.databaseName, target, environment, dryRun: options.dryRun })
  if (options.dryRun) {
    for (const table of description.tables) console.log(`[DRY RUN] ${table.schema}.${table.table}: ${Object.keys(table.fieldMap).join(', ')}`)
    console.log(`Live anonymisation requires --database ${options.databaseName} --confirm-target '${confirmation}'`)
  }
  return { target: confirmation, ...result }
}

async function main (argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(usage())
    return
  }
  console.log(JSON.stringify(await anonymiseDatabaseTarget(options), null, 2))
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Database anonymisation failed: ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = { parseArgs, usage, anonymiseDatabaseTarget, main }
