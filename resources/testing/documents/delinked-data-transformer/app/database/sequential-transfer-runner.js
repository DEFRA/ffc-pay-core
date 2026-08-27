#!/usr/bin/env node

const { createConnection } = require('./db-connection')
const { streamPrdToPre } = require('./stream-prd-to-pre')
const { validateTransferTables, discoverTargetTables, resolveTransferTableList } = require('./transfer-validation')
const { loadServiceMetadata, saveServiceMetadata } = require('./metadata-storage')
const { discoverTableMetadata } = require('./discover-service-metadata')
const { loadCheckpoint, saveCheckpoint, resetCheckpoint } = require('./checkpoint-storage')

function parseArgs (argv = process.argv.slice(2)) {
  const args = {
    services: [],
    sourceEnvironment: 'prd',
    targetEnvironment: 'pre',
    dryRun: false,
    continueOnError: false,
    tableByTable: false,
    singleTransaction: true,
    resume: false,
    resetCheckpoints: false,
    help: false
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--service') {
      args.services = [JSON.parse(argv[++i])]
    } else if (arg === '--services-file') {
      const filePath = argv[++i]
      const loaded = require(require('node:path').resolve(filePath))
      args.services = loaded.services || loaded
    } else if (arg === '--source-environment') args.sourceEnvironment = argv[++i]
    else if (arg === '--target-environment') args.targetEnvironment = argv[++i]
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--continue-on-error') args.continueOnError = true
    else if (arg === '--table-by-table') args.tableByTable = true
    else if (arg === '--no-single-transaction') args.singleTransaction = false
    else if (arg === '--resume') args.resume = true
    else if (arg === '--reset-checkpoints') args.resetCheckpoints = true
    else if (arg === '--help' || arg === '-h') args.help = true
  }

  return args
}

async function loadServiceMetadataForValidation (service, sourceEnvironment) {
  const metadata = await loadServiceMetadata(service.sourceDbName, { environment: sourceEnvironment })
  if (metadata.missing || !metadata.tables?.length) {
    console.warn(`[${service.name}] No saved metadata found for ${service.sourceDbName} (${sourceEnvironment}); validation will rely on target-side table discovery only.`)
    return null
  }
  console.log(`[${service.name}] Loaded metadata for ${service.sourceDbName} (${sourceEnvironment}): ${metadata.tables.length} table(s)`)
  return metadata.tables
}

async function ensureServiceMetadata (service, sourceEnvironment) {
  const metadata = await loadServiceMetadata(service.sourceDbName, { environment: sourceEnvironment })

  if (!metadata.missing && metadata.tables?.length) {
    console.log(`[${service.name}] Using existing metadata for ${service.sourceDbName} (${sourceEnvironment}): ${metadata.tables.length} table(s)`)
    return metadata.tables
  }

  console.log(`[${service.name}] Discovering metadata for ${service.sourceDbName} (${sourceEnvironment})...`)
  const discoveredTables = await discoverTableMetadata(service.sourceDbName, sourceEnvironment)
  const saved = await saveServiceMetadata(service.sourceDbName, discoveredTables, { environment: sourceEnvironment })
  console.log(`[${service.name}] Saved metadata: ${saved.count} table(s) -> ${saved.filePath}`)
  return discoveredTables
}

async function validateServiceTransfer (service, options = {}) {
  const sourceEnvironment = options.sourceEnvironment || 'prd'
  const targetEnvironment = options.targetEnvironment || 'pre'
  const targetDbName = service.targetDbName || `${service.baseDbName || service.name}-${targetEnvironment}`

  const sourceConnection = await createConnection(service.sourceDbName, { environment: sourceEnvironment })
  const targetConnection = await createConnection(targetDbName, { environment: targetEnvironment })

  try {
    const metadataTables = options.metadataTables || await loadServiceMetadataForValidation(service, sourceEnvironment)
    const serviceWithMetadata = metadataTables
      ? { ...service, tables: metadataTables }
      : service

    const discoveredTables = await discoverTargetTables(targetDbName, targetEnvironment)
    const tablesForValidation = resolveTransferTableList(serviceWithMetadata, discoveredTables)

    const validation = await validateTransferTables(serviceWithMetadata, sourceConnection, targetConnection, {
      discoveredTables,
      keyColumn: service.keyColumn || null
    })

    return {
      service: service.name,
      tables: tablesForValidation,
      validation
    }
  } finally {
    await sourceConnection?.pool?.end()
    await targetConnection?.pool?.end()
  }
}

async function runSequentialTransfers (services, options = {}) {
  const sourceEnvironment = options.sourceEnvironment || 'prd'
  const targetEnvironment = options.targetEnvironment || 'pre'
  const continueOnError = Boolean(options.continueOnError)
  const resume = Boolean(options.resume)
  const resetCheckpoints = Boolean(options.resetCheckpoints)
  const summary = {
    success: true,
    processed: 0,
    skipped: 0,
    succeeded: [],
    failed: []
  }

  for (const service of services) {
    console.log(`\n=== Processing service: ${service.name} ===`)
    const serviceResult = {
      service: service.name,
      sourceDbName: service.sourceDbName,
      targetDbName: service.targetDbName,
      transfer: null,
      validation: null
    }

    if (resetCheckpoints) {
      const reset = await resetCheckpoint(service.name, { sourceEnvironment, targetEnvironment })
      if (reset.reset) {
        console.log(`[${service.name}] Reset checkpoint: ${reset.filePath}`)
      }
    }

    const checkpoint = await loadCheckpoint(service.name, { sourceEnvironment, targetEnvironment })
    if (resume && checkpoint.exists && checkpoint.status === 'completed') {
      console.log(`[${service.name}] Checkpoint shows completed; skipping.`)
      summary.skipped += 1
      summary.succeeded.push({
        service: service.name,
        sourceDbName: service.sourceDbName,
        targetDbName: service.targetDbName,
        tablesValidated: Array.isArray(checkpoint.tables) ? checkpoint.tables.length : 0,
        fromCheckpoint: true
      })
      continue
    }

    if (checkpoint.exists && checkpoint.status !== 'missing') {
      console.log(`[${service.name}] Existing checkpoint found: ${checkpoint.status}. Use --resume to skip completed services or --reset-checkpoints to start fresh.`)
    }

    let metadataTables
    try {
      metadataTables = await ensureServiceMetadata(service, sourceEnvironment)
    } catch (metadataError) {
      const failure = {
        ...serviceResult,
        stage: 'metadata',
        error: metadataError.message
      }
      summary.failed.push(failure)
      summary.success = false
      console.error(`❌ Metadata discovery failed for ${service.name}: ${metadataError.message}`)
      await saveCheckpoint(service.name, { ...serviceResult, status: 'failed' }, { sourceEnvironment, targetEnvironment })
      if (!continueOnError) {
        throw new Error(`Metadata discovery failed for ${service.name}: ${metadataError.message}`)
      }
      console.log('Continuing to next service because --continue-on-error is set.')
      continue
    }

    try {
      serviceResult.transfer = await streamPrdToPre({
        sourceEnvironment,
        targetEnvironment,
        sourceDbName: service.sourceDbName,
        targetDbName: service.targetDbName,
        dryRun: Boolean(options.dryRun),
        includeLiquibaseTables: false,
        tableByTable: Boolean(options.tableByTable),
        singleTransaction: options.singleTransaction !== false
      })
      console.log('Transfer result:', JSON.stringify(serviceResult.transfer, null, 2))
    } catch (transferError) {
      const failure = {
        ...serviceResult,
        stage: 'transfer',
        error: transferError.message
      }
      summary.failed.push(failure)
      summary.success = false
      console.error(`❌ Transfer failed for ${service.name}: ${transferError.message}`)
      await saveCheckpoint(service.name, { ...serviceResult, status: 'failed' }, { sourceEnvironment, targetEnvironment })
      if (!continueOnError) {
        throw new Error(`Transfer failed for ${service.name}: ${transferError.message}`)
      }
      console.log('Continuing to next service because --continue-on-error is set.')
      continue
    }

    if (options.dryRun) {
      console.log(`[DRY RUN] Skipping validation for ${service.name}`)
      summary.succeeded.push({
        service: service.name,
        sourceDbName: service.sourceDbName,
        targetDbName: service.targetDbName,
        tablesValidated: 0
      })
      summary.processed += 1
      continue
    }

    try {
      serviceResult.validation = await validateServiceTransfer(service, {
        sourceEnvironment,
        targetEnvironment,
        dryRun: Boolean(options.dryRun),
        metadataTables
      })

      if (!serviceResult.validation.validation.passed) {
        const failure = {
          ...serviceResult,
          stage: 'validation',
          error: serviceResult.validation.validation.validationErrors.join('; ')
        }
        summary.failed.push(failure)
        summary.success = false
        console.error(`❌ Validation failed for ${service.name}: ${failure.error}`)
        await saveCheckpoint(service.name, { ...serviceResult, status: 'failed', tables: serviceResult.validation.tables }, { sourceEnvironment, targetEnvironment })
        if (!continueOnError) {
          throw new Error(`Validation failed for ${service.name}: ${failure.error}`)
        }
        console.log('Continuing to next service because --continue-on-error is set.')
        continue
      }

      console.log(`✅ Validation passed for ${service.name}`)
      await saveCheckpoint(service.name, {
        ...serviceResult,
        status: 'completed',
        tables: serviceResult.validation.tables
      }, { sourceEnvironment, targetEnvironment })
      summary.succeeded.push({
        service: service.name,
        sourceDbName: service.sourceDbName,
        targetDbName: service.targetDbName,
        tablesValidated: serviceResult.validation.tables.length
      })
      summary.processed += 1
    } catch (validationError) {
      const failure = {
        ...serviceResult,
        stage: 'validation',
        error: validationError.message
      }
      summary.failed.push(failure)
      summary.success = false
      console.error(`❌ Validation error for ${service.name}: ${validationError.message}`)
      await saveCheckpoint(service.name, { ...serviceResult, status: 'failed' }, { sourceEnvironment, targetEnvironment })
      if (!continueOnError) {
        throw new Error(`Validation error for ${service.name}: ${validationError.message}`)
      }
      console.log('Continuing to next service because --continue-on-error is set.')
    }
  }

  console.log('\n====================================')
  console.log(`Run summary: ${summary.processed}/${services.length} services processed`)
  console.log(`Skipped (checkpoint): ${summary.skipped}`)
  console.log(`Succeeded: ${summary.succeeded.length}`)
  console.log(`Failed: ${summary.failed.length}`)
  if (summary.failed.length > 0) {
    console.log('\nFailed services:')
    for (const failure of summary.failed) {
      console.log(`  - ${failure.service} (${failure.stage}): ${failure.error.split('\n')[0]}`)
    }
  }
  console.log('====================================')

  return summary
}

async function main () {
  const args = parseArgs()

  if (args.help) {
    console.log('Usage: node app/database/sequential-transfer-runner.js --service <json>')
    console.log('Or: node app/database/sequential-transfer-runner.js --services-file ./services-transfer-config.js')
    console.log('Options:')
    console.log('  --source-environment <env>   Source environment (default: prd)')
    console.log('  --target-environment <env>   Target environment (default: pre)')
    console.log('  --dry-run                    Simulate without copying data')
    console.log('  --continue-on-error          Skip failed services and report them at the end')
    console.log('  --table-by-table             Copy tables individually for progress visibility and memory safety')
    console.log('  --no-single-transaction      Restore without wrapping the whole run in a single transaction')
    console.log('  --resume                     Skip services already marked completed in checkpoints')
    console.log('  --reset-checkpoints          Delete existing checkpoints before running')
    return
  }

  const services = args.services
  const results = await runSequentialTransfers(services, {
    sourceEnvironment: args.sourceEnvironment,
    targetEnvironment: args.targetEnvironment,
    dryRun: args.dryRun,
    continueOnError: args.continueOnError,
    tableByTable: args.tableByTable,
    singleTransaction: args.singleTransaction,
    resume: args.resume,
    resetCheckpoints: args.resetCheckpoints
  })

  console.log('\nCompleted sequential transfer run:', JSON.stringify(results, null, 2))
  if (!results.success) {
    process.exitCode = 1
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Sequential transfer runner failed:', error)
    process.exit(1)
  })
}

module.exports = {
  parseArgs,
  validateServiceTransfer,
  runSequentialTransfers,
  main
}
