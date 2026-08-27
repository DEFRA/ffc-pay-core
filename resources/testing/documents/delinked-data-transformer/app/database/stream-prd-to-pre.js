const { spawn } = require('child_process')
const { createConnection } = require('./db-connection')
const { PROTECTED_TABLES, READER_ONLY_EXCLUDED_TABLES } = require('../constants/etl-protection')

const LARGE_TABLE_ROW_THRESHOLD = Number(process.env.LARGE_TABLE_ROW_THRESHOLD || 1000000)
const LARGE_TABLE_SIZE_MB_THRESHOLD = Number(process.env.LARGE_TABLE_SIZE_MB_THRESHOLD || 1024)

function buildCliEnv (token) {
  return {
    ...process.env,
    PGPASSWORD: token,
    PGSSLMODE: process.env.PGSSLMODE || 'require'
  }
}

function isLiquibasePermissionFailure (value = '') {
  return /permission denied for table .*databasechangelog|permission denied for table .*databasechangeloglock/i.test(String(value))
}

function quoteIdentifier (value) {
  return `"${String(value).replace(/"/g, '""')}"`
}

function formatColumnType (column) {
  const { data_type: dataType, udt_name: udtName, character_maximum_length: charLength, numeric_precision: numericPrecision, numeric_scale: numericScale } = column

  if (udtName && udtName.startsWith('_')) {
    return `${formatColumnType({ ...column, udt_name: udtName.slice(1) })}[]`
  }

  if (dataType === 'ARRAY') {
    return `${udtName ? udtName.replace(/^_/, '') : 'text'}[]`
  }

  if (dataType === 'character varying' || dataType === 'varchar') {
    return charLength ? `character varying(${charLength})` : 'character varying'
  }

  if (dataType === 'character') {
    return charLength ? `character(${charLength})` : 'character'
  }

  if (dataType === 'numeric' || dataType === 'decimal') {
    if (numericPrecision && numericScale !== undefined) {
      return `numeric(${numericPrecision},${numericScale})`
    }
    return 'numeric'
  }

  if (dataType === 'double precision') {
    return 'double precision'
  }

  if (dataType === 'timestamp without time zone' || dataType === 'timestamp with time zone' || dataType === 'time without time zone' || dataType === 'time with time zone' || dataType === 'date' || dataType === 'boolean' || dataType === 'integer' || dataType === 'bigint' || dataType === 'smallint' || dataType === 'uuid' || dataType === 'text') {
    return dataType
  }

  if (udtName === 'int4') return 'integer'
  if (udtName === 'int8') return 'bigint'
  if (udtName === 'bool') return 'boolean'
  if (udtName === 'varchar') return 'character varying'
  if (udtName === 'text') return 'text'

  return dataType || udtName || 'text'
}

function buildTableCreateStatement (tableName, columns = []) {
  const columnDefinitions = columns.map(column => {
    const columnName = quoteIdentifier(column.column_name)
    const nullable = column.is_nullable === 'NO' ? ' NOT NULL' : ''
    return `${columnName} ${formatColumnType(column)}${nullable}`
  })

  return `CREATE TABLE public.${quoteIdentifier(tableName)} (${columnDefinitions.join(', ')});`
}

function buildPgDumpArgs (sourceConfig, sourceDbName, options = {}) {
  const { includeLiquibaseTables = false, extraExcludedTables = [] } = options
  const excludedTables = [...PROTECTED_TABLES, ...extraExcludedTables]
  const args = [
    '-h', sourceConfig.host,
    '-p', String(sourceConfig.port),
    '-U', sourceConfig.username,
    '-d', sourceDbName,
    '-w',
    '--no-owner',
    '--no-privileges',
    '--no-tablespaces',
    '--clean',
    '--if-exists',
    '--format=plain',
    '--verbose'
  ]

  if (!includeLiquibaseTables) {
    for (const table of excludedTables) {
      args.push('--exclude-table', `public."${table}"`)
      args.push('--exclude-table-data', `public."${table}"`)
    }
  }

  return args
}

function replaceEnvironmentSuffix (databaseName, sourceEnvironment = 'prd', targetEnvironment = 'pre') {
  const sourceSuffix = `-${sourceEnvironment}`
  const targetSuffix = `-${targetEnvironment}`
  const value = (databaseName || '').toLowerCase()

  if (value.endsWith(sourceSuffix)) {
    return `${databaseName.slice(0, databaseName.length - sourceSuffix.length)}${targetSuffix}`
  }

  return databaseName
}

function resolveTargetDatabaseName (sourceDbName, sourceEnvironment = 'prd', targetEnvironment = 'pre', targetDbName) {
  if (targetDbName) {
    return targetDbName
  }

  return replaceEnvironmentSuffix(sourceDbName, sourceEnvironment, targetEnvironment)
}

function filterPayDatabases (databaseNames = []) {
  return databaseNames.filter((databaseName) => {
    const value = databaseName.toLowerCase()
    return value.startsWith('ffc-pay-') && !value.includes('ffc-doc-')
  })
}

async function ensureTargetDatabaseExists (targetDbName, targetEnvironment = 'pre') {
  const targetConnection = await createConnection('postgres', { environment: targetEnvironment })
  const targetConfig = targetConnection.config

  if (!targetConnection.token) {
    throw new Error(`No authentication token available for target environment ${targetEnvironment}`)
  }
  const env = buildCliEnv(targetConnection.token)

  try {
    const exists = await new Promise((resolve, reject) => {
      const args = ['-h', targetConfig.host, '-p', String(targetConfig.port || 5432), '-U', targetConfig.username, '-d', 'postgres', '-w', '-tAc', `SELECT 1 FROM pg_database WHERE datname = '${targetDbName}'`]
      const child = spawn('psql', args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''

      child.stdout.on('data', chunk => { stdout += chunk.toString() })
      child.stderr.on('data', chunk => { stderr += chunk.toString() })
      child.on('close', code => {
        if (code !== 0) {
          reject(new Error(`psql existence check failed for ${targetDbName}: ${stderr || stdout}`))
          return
        }
        resolve(stdout.trim() === '1')
      })
    })

    if (!exists) {
      await new Promise((resolve, reject) => {
        const args = ['-h', targetConfig.host, '-p', String(targetConfig.port || 5432), '-U', targetConfig.username, '-d', 'postgres', '-w', '-c', `CREATE DATABASE "${targetDbName}"`]
        const child = spawn('psql', args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
        let stderr = ''

        child.stderr.on('data', chunk => { stderr += chunk.toString() })
        child.on('close', code => {
          if (code !== 0) {
            reject(new Error(`Failed to create target database ${targetDbName}: ${stderr}`))
            return
          }
          resolve()
        })
      })
    }
  } finally {
    await targetConnection?.pool?.end()
  }
}

async function truncateTargetTablesExceptProtected (targetDbName, targetEnvironment = 'pre', options = {}) {
  const { preserveLiquibaseTables = true } = options
  const protectedTables = preserveLiquibaseTables ? PROTECTED_TABLES : []
  const targetConnection = await createConnection(targetDbName, { environment: targetEnvironment })
  const targetConfig = targetConnection.config

  if (!targetConnection.token) {
    throw new Error(`No authentication token available for target environment ${targetEnvironment}`)
  }
  const env = buildCliEnv(targetConnection.token)

  try {
    const tableNames = await new Promise((resolve, reject) => {
      const args = ['-h', targetConfig.host, '-p', String(targetConfig.port || 5432), '-U', targetConfig.username, '-d', targetDbName, '-w', '-tAc', 'SELECT table_name FROM information_schema.tables WHERE table_schema = \'public\' AND table_type = \'BASE TABLE\' ORDER BY table_name']
      const child = spawn('psql', args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''

      child.stdout.on('data', chunk => { stdout += chunk.toString() })
      child.stderr.on('data', chunk => { stderr += chunk.toString() })
      child.on('close', code => {
        if (code !== 0) {
          reject(new Error(`Failed to list tables in ${targetDbName}: ${stderr || stdout}`))
          return
        }
        resolve(stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean))
      })
    })

    const tablesToTruncate = tableNames.filter(tableName => !protectedTables.includes(tableName.toLowerCase()))
    for (const tableName of tablesToTruncate) {
      await new Promise((resolve, reject) => {
        const args = ['-h', targetConfig.host, '-p', String(targetConfig.port || 5432), '-U', targetConfig.username, '-d', targetDbName, '-w', '-c', `TRUNCATE TABLE public."${tableName}" CASCADE`]
        const child = spawn('psql', args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
        let stderr = ''

        child.stderr.on('data', chunk => { stderr += chunk.toString() })
        child.on('close', code => {
          if (code !== 0) {
            reject(new Error(`Failed to truncate ${tableName} in ${targetDbName}: ${stderr}`))
            return
          }
          resolve()
        })
      })
    }
  } finally {
    await targetConnection?.pool?.end()
  }
}

async function executePsqlCommand (config, databaseName, sql, token) {
  if (!token) {
    throw new Error(`No authentication token available for psql command against ${databaseName}`)
  }
  return await new Promise((resolve, reject) => {
    const args = [
      '-h', config.host,
      '-p', String(config.port || 5432),
      '-U', config.username,
      '-d', databaseName,
      '-w',
      '-A',
      '-t',
      '-v', 'ON_ERROR_STOP=1',
      '-c', sql
    ]

    const child = spawn('psql', args, { env: buildCliEnv(token), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`psql command failed for ${databaseName}: ${stderr || stdout}`))
        return
      }
      resolve(stdout.trim())
    })
  })
}

async function describeTableColumns (sourceConfig, sourceDbName, tableName, token) {
  const sql = `SELECT json_agg(row_to_json(columns)) FROM (
    SELECT column_name, data_type, udt_name, is_nullable, character_maximum_length, numeric_precision, numeric_scale, datetime_precision
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = '${tableName}'
    ORDER BY ordinal_position
  ) AS columns;`

  const payload = await executePsqlCommand(sourceConfig, sourceDbName, sql, token)
  const columns = JSON.parse(payload || '[]')
  return Array.isArray(columns) ? columns : []
}

async function getDatabaseSize (sourceConfig, sourceDbName, token) {
  const sql = `SELECT pg_database_size('${sourceDbName}') AS size`
  const payload = await executePsqlCommand(sourceConfig, sourceDbName, sql, token)
  const match = String(payload).match(/(\d+)/)
  return match ? Number(match[1]) : 0
}

async function getTableSizes (sourceConfig, sourceDbName, token) {
  const sql = `
    SELECT
      c.relname AS table_name,
      c.reltuples::bigint AS row_estimate,
      pg_relation_size(c.oid) AS size_bytes
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname NOT IN ('databasechangelog', 'databasechangeloglock')
    ORDER BY pg_relation_size(c.oid) DESC
  `
  const payload = await executePsqlCommand(sourceConfig, sourceDbName, sql, token)
  const lines = String(payload).split('\n').filter(Boolean)
  return lines.map(line => {
    const [tableName, rowEstimate, sizeBytes] = line.split('|')
    return {
      tableName: tableName?.trim(),
      rowEstimate: Number(rowEstimate) || 0,
      sizeBytes: Number(sizeBytes) || 0
    }
  })
}

function formatBytes (bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(2)} ${units[unitIndex]}`
}

async function copyTableRows (sourceConfig, sourceDbName, targetConfig, targetDbName, tableName, sourceToken, targetToken) {
  if (!sourceToken) {
    throw new Error(`No authentication token available for source database ${sourceDbName}`)
  }
  if (!targetToken) {
    throw new Error(`No authentication token available for target database ${targetDbName}`)
  }

  const createStatement = buildTableCreateStatement(tableName, await describeTableColumns(sourceConfig, sourceDbName, tableName, sourceToken))

  await executePsqlCommand(targetConfig, targetDbName, `DROP TABLE IF EXISTS public.${quoteIdentifier(tableName)} CASCADE; ${createStatement}`, targetToken)

  return await new Promise((resolve, reject) => {
    const exportArgs = [
      '-h', sourceConfig.host,
      '-p', String(sourceConfig.port || 5432),
      '-U', sourceConfig.username,
      '-d', sourceDbName,
      '-w',
      '-v', 'ON_ERROR_STOP=1',
      '-c', `COPY (SELECT * FROM public.${quoteIdentifier(tableName)}) TO STDOUT WITH CSV HEADER`
    ]

    const importArgs = [
      '-h', targetConfig.host,
      '-p', String(targetConfig.port || 5432),
      '-U', targetConfig.username,
      '-d', targetDbName,
      '-w',
      '-v', 'ON_ERROR_STOP=1',
      '-c', `COPY public.${quoteIdentifier(tableName)} FROM STDIN WITH CSV HEADER`
    ]

    const exportStream = spawn('psql', exportArgs, { env: buildCliEnv(sourceToken), stdio: ['ignore', 'pipe', 'pipe'] })
    const importStream = spawn('psql', importArgs, { env: buildCliEnv(targetToken), stdio: ['pipe', 'pipe', 'pipe'] })

    let stderr = ''
    let bytesTransferred = 0

    exportStream.stdout.on('data', chunk => {
      bytesTransferred += chunk.length
      if (bytesTransferred % (10 * 1024 * 1024) < chunk.length) {
        console.log(`  ${tableName}: transferred ${formatBytes(bytesTransferred)}...`)
      }
      if (!importStream.stdin.destroyed) {
        const canContinue = importStream.stdin.write(chunk)
        if (!canContinue) {
          exportStream.stdout.pause()
          importStream.stdin.once('drain', () => exportStream.stdout.resume())
        }
      }
    })

    exportStream.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })

    exportStream.on('error', error => reject(error))
    exportStream.on('close', code => {
      if (code !== 0) {
        reject(new Error(`Failed to export ${tableName} from ${sourceDbName}: ${stderr}`))
        return
      }
      importStream.stdin.end()
    })

    importStream.stderr.on('data', chunk => {
      process.stderr.write(`[psql:${tableName}] ${chunk.toString()}`)
    })

    importStream.on('error', error => reject(error))
    importStream.on('close', code => {
      if (code !== 0) {
        reject(new Error(`Failed to restore ${tableName} to ${targetDbName}: ${stderr}`))
        return
      }
      console.log(`  ${tableName}: copied ${formatBytes(bytesTransferred)}`)
      resolve({ tableName, restored: true, bytesTransferred })
    })
  })
}

async function restoreLiquibaseMetadataTables (sourceConnection, targetConnection, sourceDbName, targetDbName) {
  const protectedTables = [...PROTECTED_TABLES, ...READER_ONLY_EXCLUDED_TABLES]
  const sourceConfig = sourceConnection.config
  const targetConfig = targetConnection.config

  for (const tableName of protectedTables) {
    await copyTableRows(sourceConfig, sourceDbName, targetConfig, targetDbName, tableName, sourceConnection.token, targetConnection.token)
  }

  return true
}

async function streamTableByTable (sourceConfig, sourceDbName, targetConfig, targetDbName, tableNames, options = {}) {
  const { sourceToken, targetToken, dryRun = false } = options
  const results = []
  let totalRows = 0

  console.log(`Copying ${tableNames.length} table(s) individually`)

  for (let i = 0; i < tableNames.length; i++) {
    const tableName = tableNames[i]
    console.log(`[${i + 1}/${tableNames.length}] Copying table ${tableName}`)

    if (dryRun) {
      console.log(`[DRY RUN] Would copy ${tableName}`)
      results.push({ tableName, restored: true, dryRun: true })
      continue
    }

    const result = await copyTableRows(sourceConfig, sourceDbName, targetConfig, targetDbName, tableName, sourceToken, targetToken)
    results.push(result)
    totalRows += result.rowCount || 0
    console.log(`  ${tableName}: done`)
  }

  return { results, totalRows }
}

async function copyDatabaseStream (sourceDbName, targetDbName, options = {}) {
  const {
    sourceEnvironment = 'prd',
    targetEnvironment = 'pre',
    dryRun = false,
    includeLiquibaseTables = false,
    tableByTable = false,
    singleTransaction = true
  } = options

  const sourceConnection = await createConnection(sourceDbName, { environment: sourceEnvironment })
  const targetConnection = await createConnection(targetDbName, { environment: targetEnvironment })

  if (!sourceConnection.token) {
    throw new Error(`No authentication token available for source environment ${sourceEnvironment}`)
  }
  if (!targetConnection.token) {
    throw new Error(`No authentication token available for target environment ${targetEnvironment}`)
  }

  try {
    const sourceConfig = sourceConnection.config
    const targetConfig = targetConnection.config

    if (dryRun) {
      const dbSize = await getDatabaseSize(sourceConfig, sourceDbName, sourceConnection.token)
      const tableSizes = await getTableSizes(sourceConfig, sourceDbName, sourceConnection.token)
      const largeTables = tableSizes.filter(t => t.rowEstimate >= LARGE_TABLE_ROW_THRESHOLD || t.sizeBytes >= LARGE_TABLE_SIZE_MB_THRESHOLD * 1024 * 1024)

      console.log(`[DRY RUN] Would stream ${sourceDbName} -> ${targetDbName}`)
      console.log(`[DRY RUN] Source database size: ${formatBytes(dbSize)}`)
      console.log(`[DRY RUN] Tables: ${tableSizes.length}, large tables: ${largeTables.length}`)
      if (largeTables.length > 0) {
        console.log('[DRY RUN] Large tables:')
        for (const table of largeTables.slice(0, 10)) {
          console.log(`  - ${table.tableName}: ~${table.rowEstimate.toLocaleString()} rows, ${formatBytes(table.sizeBytes)}`)
        }
      }
      return { sourceDbName, targetDbName, dryRun: true, copied: false, tableCount: tableSizes.length, largeTableCount: largeTables.length }
    }

    const dbSize = await getDatabaseSize(sourceConfig, sourceDbName, sourceConnection.token)
    const tableSizes = await getTableSizes(sourceConfig, sourceDbName, sourceConnection.token)
    const largeTables = tableSizes.filter(t => t.rowEstimate >= LARGE_TABLE_ROW_THRESHOLD || t.sizeBytes >= LARGE_TABLE_SIZE_MB_THRESHOLD * 1024 * 1024)

    console.log(`Source database size: ${formatBytes(dbSize)}`)
    console.log(`Tables: ${tableSizes.length}, large tables: ${largeTables.length}`)

    await ensureTargetDatabaseExists(targetDbName, targetEnvironment)
    await truncateTargetTablesExceptProtected(targetDbName, targetEnvironment, { preserveLiquibaseTables: true })

    if (tableByTable || largeTables.length > 0) {
      console.log('Using table-by-table copy mode for better progress visibility and memory safety')
      const { results, totalRows } = await streamTableByTable(
        sourceConfig,
        sourceDbName,
        targetConfig,
        targetDbName,
        tableSizes.map(t => t.tableName),
        { sourceToken: sourceConnection.token, targetToken: targetConnection.token, dryRun: false }
      )
      return { sourceDbName, targetDbName, dryRun: false, copied: true, tableByTable: true, tableCount: results.length, totalRows }
    }

    try {
      return await new Promise((resolve, reject) => {
        const dumpArgs = buildPgDumpArgs(sourceConfig, sourceDbName, { includeLiquibaseTables })

        const restoreArgs = [
          '-h', targetConfig.host,
          '-p', String(targetConfig.port),
          '-U', targetConfig.username,
          '-d', targetDbName,
          '-w',
          '--set=ON_ERROR_STOP=1'
        ]
        if (singleTransaction) {
          restoreArgs.push('--single-transaction')
        }

        let bytesTransferred = 0
        let dumpStderr = ''
        const dump = spawn('pg_dump', dumpArgs, { env: buildCliEnv(sourceConnection.token), stdio: ['ignore', 'pipe', 'pipe'] })
        const restore = spawn('psql', restoreArgs, { env: buildCliEnv(targetConnection.token), stdio: ['pipe', 'pipe', 'pipe'] })

        dump.stdout.on('data', chunk => {
          bytesTransferred += chunk.length
          if (bytesTransferred % (10 * 1024 * 1024) < chunk.length) {
            console.log(`Transferred ${formatBytes(bytesTransferred)}...`)
          }
          if (!restore.stdin.destroyed) {
            const canContinue = restore.stdin.write(chunk)
            if (!canContinue) {
              dump.stdout.pause()
              restore.stdin.once('drain', () => dump.stdout.resume())
            }
          }
        })

        dump.stderr.on('data', chunk => {
          const message = chunk.toString()
          dumpStderr += message
          process.stderr.write(`[pg_dump] ${message}`)
        })

        dump.on('error', error => reject(error))
        dump.on('close', code => {
          if (code !== 0) {
            reject(new Error(`pg_dump failed for ${sourceDbName} with exit code ${code}. ${dumpStderr.trim()}`))
            return
          }
          restore.stdin.end()
        })

        restore.stderr.on('data', chunk => {
          process.stderr.write(`[psql] ${chunk.toString()}`)
        })

        restore.on('error', error => reject(error))
        restore.on('close', code => {
          if (code !== 0) {
            reject(new Error(`psql restore failed for ${targetDbName} with exit code ${code}`))
            return
          }
          console.log(`Streamed ${formatBytes(bytesTransferred)} total`)
          resolve({ sourceDbName, targetDbName, dryRun: false, copied: true, bytesTransferred })
        })
      })
    } catch (error) {
      const errorText = error?.message || ''
      if (includeLiquibaseTables && isLiquibasePermissionFailure(errorText)) {
        console.warn('Detected source-role permission issue on Liquibase tables; falling back to dump-with-exclusions plus separate AD-auth metadata restore.')

        await new Promise((resolve, reject) => {
          const fallbackDumpArgs = buildPgDumpArgs(sourceConfig, sourceDbName, {
            includeLiquibaseTables: false,
            extraExcludedTables: READER_ONLY_EXCLUDED_TABLES
          })
          const restoreArgs = [
            '-h', targetConfig.host,
            '-p', String(targetConfig.port),
            '-U', targetConfig.username,
            '-d', targetDbName,
            '-w',
            '--single-transaction',
            '--set=ON_ERROR_STOP=1'
          ]

          const dump = spawn('pg_dump', fallbackDumpArgs, { env: buildCliEnv(sourceConnection.token), stdio: ['ignore', 'pipe', 'pipe'] })
          const restore = spawn('psql', restoreArgs, { env: buildCliEnv(targetConnection.token), stdio: ['pipe', 'pipe', 'pipe'] })

          dump.stdout.on('data', chunk => {
            if (!restore.stdin.destroyed) restore.stdin.write(chunk)
          })

          dump.stderr.on('data', chunk => {
            process.stderr.write(`[pg_dump] ${chunk.toString()}`)
          })

          dump.on('error', error => reject(error))
          dump.on('close', code => {
            if (code !== 0) {
              reject(new Error(`Fallback pg_dump failed for ${sourceDbName} with exit code ${code}`))
              return
            }
            restore.stdin.end()
          })

          restore.stderr.on('data', chunk => {
            process.stderr.write(`[psql] ${chunk.toString()}`)
          })

          restore.on('error', error => reject(error))
          restore.on('close', code => {
            if (code !== 0) {
              reject(new Error(`Fallback psql restore failed for ${targetDbName} with exit code ${code}`))
              return
            }
            resolve()
          })
        })

        await restoreLiquibaseMetadataTables(sourceConnection, targetConnection, sourceDbName, targetDbName)
        return { sourceDbName, targetDbName, dryRun: false, copied: true, liquibaseRestored: true }
      }

      throw error
    }
  } finally {
    await sourceConnection?.pool?.end()
    await targetConnection?.pool?.end()
  }
}

async function streamPrdToPre (options = {}) {
  const {
    dryRun = false,
    sourceDbName = 'ffc-pay-alerting-prd',
    targetDbName,
    sourceEnvironment = 'prd',
    targetEnvironment = 'pre',
    includeLiquibaseTables = false,
    tableByTable = false,
    singleTransaction = true
  } = options

  const chosenSourceDbName = sourceDbName
  const chosenTargetDbName = resolveTargetDatabaseName(chosenSourceDbName, sourceEnvironment, targetEnvironment, targetDbName)

  console.log(`Starting streaming copy for ${chosenSourceDbName} to ${chosenTargetDbName}`)
  if (includeLiquibaseTables) {
    console.log('Including Liquibase metadata tables because the target database is expected to be blank for this validation copy.')
  }

  return copyDatabaseStream(chosenSourceDbName, chosenTargetDbName, {
    sourceEnvironment,
    targetEnvironment,
    dryRun,
    includeLiquibaseTables,
    tableByTable,
    singleTransaction
  })
}

module.exports = {
  buildPgDumpArgs,
  isLiquibasePermissionFailure,
  replaceEnvironmentSuffix,
  resolveTargetDatabaseName,
  filterPayDatabases,
  streamPrdToPre,
  copyDatabaseStream
}
