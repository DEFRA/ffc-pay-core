#!/usr/bin/env node

const path = require('node:path')
const fs = require('node:fs/promises')
const { createConnection, getEnvironmentSuffix } = require('./db-connection')
const config = require('../config')

function parseArgs (argv = process.argv.slice(2)) {
  const args = {
    service: null,
    services: [],
    servicesFile: null,
    sourceEnvironment: config.sourceEnvironment || 'recovery',
    targetEnvironment: config.targetEnvironment || 'test',
    managedIdentity: null,
    managedIdentityPrefix: 'DEVFFCINFMID',
    dryRun: true,
    verify: false,
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
    else if (arg === '--managed-identity') args.managedIdentity = argv[++i]
    else if (arg === '--managed-identity-prefix') args.managedIdentityPrefix = argv[++i]
    else if (arg === '--apply') args.dryRun = false
    else if (arg === '--verify') args.verify = true
    else if (arg === '--metadata-dir') args.metadataDir = path.resolve(process.cwd(), argv[++i])
    else if (arg === '--help' || arg === '-h') args.help = true
  }

  return args
}

function quoteIdentifier (value) {
  return `"${String(value).replace(/"/g, '""')}"`
}

async function listMetadataFiles (metadataDir) {
  try {
    const entries = await fs.readdir(metadataDir, { withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => path.join(metadataDir, entry.name))
      .sort()
  } catch {
    return []
  }
}

async function readMetadataFile (filePath) {
  const content = await fs.readFile(filePath, 'utf8')
  const parsed = JSON.parse(content)
  return {
    databaseName: parsed.databaseName || path.basename(filePath, '.json'),
    environment: parsed.environment || 'unknown',
    tables: Array.isArray(parsed.tables)
      ? parsed.tables.map(table => String(table.name || table).trim()).filter(Boolean)
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
  if (options.services?.length) {
    return options.services.map(service => ({
      name: service.sourceDbName || service.name,
      sourceDbName: service.sourceDbName || service.name,
      targetDbName: service.targetDbName || resolveTargetDatabaseName(service.sourceDbName || service.name, options.sourceEnvironment, options.targetEnvironment),
      metadata: null
    }))
  }

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

  return services
}

async function discoverManagedIdentityFromLiquibase (connection, options) {
  if (options.managedIdentity) {
    return options.managedIdentity
  }

  const candidates = new Set()

  const ownerResult = await connection.query(
    `SELECT pg_get_userbyid(c.relowner) AS role_name
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'databasechangelog'`
  )
  for (const row of ownerResult.rows) {
    if (row.role_name) candidates.add(row.role_name)
  }

  const granteeResult = await connection.query(
    `SELECT DISTINCT grantee AS role_name
     FROM information_schema.table_privileges
     WHERE table_schema = 'public'
       AND table_name = 'databasechangelog'
       AND grantee NOT IN ('PUBLIC', 'postgres', 'azure_pg_admin', 'azure_superuser')`
  )
  for (const row of granteeResult.rows) {
    if (row.role_name) candidates.add(row.role_name)
  }

  const candidatesArray = [...candidates]
  if (!candidatesArray.length) {
    throw new Error('No managed identity candidate found from databasechangelog owner or grantees')
  }

  const prefixMatch = candidatesArray.find(role =>
    role.toLowerCase().startsWith(options.managedIdentityPrefix.toLowerCase())
  )

  if (prefixMatch) return prefixMatch
  if (candidatesArray.length === 1) return candidatesArray[0]

  throw new Error(`Multiple managed identity candidates found in databasechangelog: ${candidatesArray.join(', ')}. Use --managed-identity to specify one.`)
}

async function roleExists (connection, roleName) {
  const result = await connection.query(
    'SELECT 1 FROM pg_roles WHERE rolname = $1',
    [roleName]
  )
  return result.rows.length > 0
}

async function findTablesMissingGrant (connection, managedIdentity) {
  const result = await connection.query(
    `SELECT
       c.relname AS table_name,
       pg_get_userbyid(c.relowner) AS owner
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relname NOT IN ('databasechangelog', 'databasechangeloglock')
       AND NOT EXISTS (
         SELECT 1
         FROM information_schema.table_privileges t
         WHERE t.table_schema = n.nspname
           AND t.table_name = c.relname
           AND t.grantee = $1
       )
     ORDER BY c.relname`,
    [managedIdentity]
  )

  return result.rows
}

async function applyGrants (connection, managedIdentity, tables) {
  const tableList = tables.map(row => `public.${quoteIdentifier(row.table_name)}`).join(', ')

  await connection.query('BEGIN')
  try {
    await connection.query(`GRANT ALL PRIVILEGES ON TABLE ${tableList} TO ${quoteIdentifier(managedIdentity)}`)
    await connection.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quoteIdentifier(managedIdentity)}`)
    await connection.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${quoteIdentifier(managedIdentity)}`)
    await connection.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${quoteIdentifier(managedIdentity)}`)
    await connection.query('COMMIT')
  } catch (error) {
    await connection.query('ROLLBACK')
    throw error
  }
}

function printReport (serviceName, targetDbName, managedIdentity, tables) {
  console.log(`\n=== ${serviceName} ===`)
  console.log(`Target database: ${targetDbName}`)
  console.log(`Managed identity: ${managedIdentity}`)
  console.log(`Tables missing grant: ${tables.length}`)

  if (!tables.length) {
    console.log('All tables already have the grant.')
    return
  }

  console.log('Affected tables:')
  for (const row of tables) {
    console.log(`  - ${row.table_name} (owner: ${row.owner})`)
  }
}

async function processService (service, options) {
  const { targetEnvironment } = options
  const { sourceDbName, targetDbName } = service

  console.log(`\n=== ${service.name} ===`)
  console.log(`Source DB: ${sourceDbName}`)
  console.log(`Target DB: ${targetDbName}`)

  const connection = await createConnection(targetDbName, { environment: targetEnvironment })

  try {
    const managedIdentity = await discoverManagedIdentityFromLiquibase(connection, options)
    console.log(`Discovered managed identity: ${managedIdentity}`)

    const roleFound = await roleExists(connection, managedIdentity)
    if (!roleFound) {
      throw new Error(`Managed identity role "${managedIdentity}" does not exist in target database "${targetDbName}"`)
    }

    const missingBefore = await findTablesMissingGrant(connection, managedIdentity)
    printReport(service.name, targetDbName, managedIdentity, missingBefore)

    if (options.dryRun) {
      console.log('  [Dry run] No changes made. Use --apply to grant privileges.')
      return { service: service.name, targetDbName, managedIdentity, missing: missingBefore.length, applied: 0 }
    }

    if (!missingBefore.length) {
      console.log('  No grants needed.')
      return { service: service.name, targetDbName, managedIdentity, missing: 0, applied: 0 }
    }

    console.log(`  Applying grants to ${missingBefore.length} table(s)...`)
    await applyGrants(connection, managedIdentity, missingBefore)
    console.log('  Grants applied successfully.')

    if (options.verify) {
      console.log('  Verifying grants after apply...')
      const missingAfter = await findTablesMissingGrant(connection, managedIdentity)
      printReport(service.name, targetDbName, managedIdentity, missingAfter)

      if (missingAfter.length) {
        throw new Error(`Verification failed for ${service.name}: ${missingAfter.length} table(s) still missing grant`)
      }
      console.log('  Verification passed.')
    }

    return { service: service.name, targetDbName, managedIdentity, missing: missingBefore.length, applied: missingBefore.length }
  } finally {
    await connection?.pool?.end()
  }
}

async function run () {
  const options = parseArgs()

  if (options.help) {
    console.log('Usage: node grant-managed-identity.js [options]\n\n' + [
      '--service <name>              single service to process',
      '--services-file <path>        JSON file with a "services" array',
      '--source-environment <env>    default: config.sourceEnvironment',
      '--target-environment <env>    default: config.targetEnvironment',
      '--managed-identity <name>     override the managed identity name',
      '--managed-identity-prefix <p> default: DEVFFCINFMID',
      '--apply                       apply grants (default is dry-run)',
      '--verify                      re-check after applying grants',
      '--metadata-dir <dir>          directory to scan for metadata files'
    ].join('\n'))
    process.exit(0)
  }

  const services = await resolveServices(options)

  if (!services.length) {
    throw new Error('No services found to process. Use --service, --services-file, or ensure metadata files exist.')
  }

  console.log(`Processing ${services.length} service(s) in ${options.dryRun ? 'dry-run' : 'apply'} mode`)
  console.log(`Source environment: ${options.sourceEnvironment}`)
  console.log(`Target environment: ${options.targetEnvironment}`)

  const summary = []
  for (const service of services) {
    const result = await processService(service, options)
    summary.push(result)
  }

  console.log('\n=== Summary ===')
  let totalMissing = 0
  for (const result of summary) {
    console.log(`${result.service.padEnd(35)} | target=${result.targetDbName.padEnd(35)} | missing=${String(result.missing).padEnd(6)} | applied=${result.applied}`)
  }
  console.log(`\nTotal tables missing grant across services: ${totalMissing}`)
}

run().catch(error => {
  console.error('\nGrant managed identity failed:')
  console.error(error)
  process.exit(1)
})
