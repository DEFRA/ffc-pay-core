const { spawn } = require('child_process')
const { Transform } = require('stream')
const { createConnection, resolveDatabaseEnvironmentConfig, getEnhancedAzureToken } = require('./db-connection')
const { PROTECTED_TABLES, READER_ONLY_EXCLUDED_TABLES } = require('../constants/etl-protection')

const LARGE_TABLE_ROW_THRESHOLD = Number(process.env.LARGE_TABLE_ROW_THRESHOLD || 1000000)
const LARGE_TABLE_SIZE_MB_THRESHOLD = Number(process.env.LARGE_TABLE_SIZE_MB_THRESHOLD || 1024)

async function refreshToken (environment) {
  const envConfig = resolveDatabaseEnvironmentConfig({ environment })
  if (!envConfig.useAzureAd) {
    return envConfig.password
  }
  const token = await getEnhancedAzureToken({ environment })
  return token
}

function buildCliEnv (token, options = {}) {
  return {
    ...process.env,
    PGPASSWORD: token,
    PGSSLMODE: options.ssl === false ? 'disable' : (process.env.PGSSLMODE || 'require')
  }
}

function createDumpSanitizer () {
  let buffer = ''
  const isSafeLine = (line) => {
    if (/^\\(?:un)?restrict\b/.test(line)) return false
    if (/^SET\s+default_table_access_method\s*=/i.test(line)) return false
    return true
  }
  const rewriteGeneratedColumn = (line) => {
    // PostgreSQL < 12 does not support GENERATED ALWAYS AS (...) STORED.
    // Convert generated columns to plain columns so the schema loads on older servers.
    return line.replace(/\s+GENERATED\s+ALWAYS\s+AS\s+\(.+?\)\s+STORED/i, '')
  }
  return new Transform({
    transform (chunk, encoding, callback) {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop()
      const filtered = lines.filter(isSafeLine).map(rewriteGeneratedColumn)
      if (filtered.length) {
        this.push(filtered.join('\n') + '\n')
      }
      callback()
    },
    flush (callback) {
      if (buffer && isSafeLine(buffer)) {
        this.push(rewriteGeneratedColumn(buffer))
      }
      callback()
    }
  })
}

function sanitizeDumpString (value = '') {
  return value.replace(/^\\(?:un)?restrict\b.*$/gm, '')
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
  const env = buildCliEnv(targetConnection.token, { ssl: targetConnection.config.ssl })

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
  const env = buildCliEnv(targetConnection.token, { ssl: targetConnection.config.ssl })

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
  console.log(`[DEBUG executePsqlCommand] databaseName=${databaseName} tokenStartsWith=${token.slice(0, 20)} tokenLength=${token.length} sqlLength=${sql.length} sqlLast100=${JSON.stringify(sql.slice(-100))}`)
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

    const child = spawn('psql', args, { env: buildCliEnv(token, { ssl: config.ssl }), stdio: ['ignore', 'pipe', 'pipe'] })
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

function stripPsqlMetaCommands (sql) {
  return sql
    .split('\n')
    .filter(line => !/^\\[a-zA-Z]/.test(line))
    .join('\n')
}

function stripUnsupportedSetCommands (sql) {
  // PostgreSQL < 12 does not recognise default_table_access_method.
  return sql
    .split('\n')
    .filter(line => !/^SET\s+default_table_access_method\s*=/i.test(line))
    .join('\n')
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

function normaliseTableName (value) {
  return String(value || '').replace(/^public\./, '')
}

async function getForeignKeyDependencies (sourceConfig, sourceDbName, sourceToken) {
  const sql = `
    SELECT
      conrelid::regclass::text AS table_name,
      confrelid::regclass::text AS referenced_table_name
    FROM pg_constraint
    WHERE contype = 'f'
      AND connamespace = 'public'::regnamespace
  `
  const payload = await executePsqlCommand(sourceConfig, sourceDbName, sql, sourceToken)
  return String(payload)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [tableName, referencedTableName] = line.split('|')
      return {
        tableName: normaliseTableName(tableName),
        referencedTableName: normaliseTableName(referencedTableName)
      }
    })
    .filter(dep => dep.tableName && dep.referencedTableName && dep.tableName !== dep.referencedTableName)
}

function sortTablesByDependencies (tables, dependencies) {
  const tableSet = new Set(tables)
  const graph = new Map()
  const inDegree = new Map()

  for (const table of tables) {
    graph.set(table, [])
    inDegree.set(table, 0)
  }

  for (const { tableName, referencedTableName } of dependencies) {
    if (!tableSet.has(tableName) || !tableSet.has(referencedTableName)) {
      continue
    }
    graph.get(referencedTableName).push(tableName)
    inDegree.set(tableName, (inDegree.get(tableName) || 0) + 1)
  }

  const queue = []
  for (const [table, degree] of inDegree.entries()) {
    if (degree === 0) {
      queue.push(table)
    }
  }

  const sorted = []
  while (queue.length > 0) {
    const table = queue.shift()
    sorted.push(table)
    for (const dependent of graph.get(table) || []) {
      const newDegree = inDegree.get(dependent) - 1
      inDegree.set(dependent, newDegree)
      if (newDegree === 0) {
        queue.push(dependent)
      }
    }
  }

  if (sorted.length !== tables.length) {
    const remaining = tables.filter(table => !sorted.includes(table))
    console.warn(`Circular foreign-key dependencies detected; appending remaining tables: ${remaining.join(', ')}`)
    sorted.push(...remaining)
  }

  return sorted
}

async function getTableSchemaDump (sourceConfig, sourceDbName, tableName, token) {
  if (!token) {
    throw new Error(`No authentication token available for source database ${sourceDbName}`)
  }

  return await new Promise((resolve, reject) => {
    const args = [
      '-h', sourceConfig.host,
      '-p', String(sourceConfig.port || 5432),
      '-U', sourceConfig.username,
      '-d', sourceDbName,
      '-w',
      '--no-owner',
      '--no-privileges',
      '--no-tablespaces',
      '--schema-only',
      '--format=plain',
      '--verbose',
      '--table', `public.${quoteIdentifier(tableName)}`
    ]

    const child = spawn('pg_dump', args, { env: buildCliEnv(token, { ssl: sourceConfig.ssl }), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', error => reject(error))
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`pg_dump schema-only failed for public.${tableName}: ${stderr || stdout}`))
        return
      }
      resolve(sanitizeDumpString(stdout))
    })
  })
}

async function copyTableRows (sourceConfig, sourceDbName, targetConfig, targetDbName, tableName, sourceToken, targetToken, options = {}) {
  if (!sourceToken) {
    throw new Error(`No authentication token available for source database ${sourceDbName}`)
  }
  if (!targetToken) {
    throw new Error(`No authentication token available for target database ${targetDbName}`)
  }

  const { dataOnly = false } = options

  if (!dataOnly) {
    let createStatement
    try {
      createStatement = await getTableSchemaDump(sourceConfig, sourceDbName, tableName, sourceToken)
    } catch (error) {
      console.warn(`  ${tableName}: schema dump failed (${error.message}); falling back to column-only CREATE TABLE. Keys/indexes may be missing.`)
      createStatement = buildTableCreateStatement(tableName, await describeTableColumns(sourceConfig, sourceDbName, tableName, sourceToken))
    }
    const cleanCreateStatement = stripUnsupportedSetCommands(stripPsqlMetaCommands(createStatement))
    await executePsqlCommand(targetConfig, targetDbName, `DROP TABLE IF EXISTS public.${quoteIdentifier(tableName)} CASCADE; ${cleanCreateStatement}`, targetToken)
  } else {
    await executePsqlCommand(targetConfig, targetDbName, `TRUNCATE TABLE public.${quoteIdentifier(tableName)} CASCADE`, targetToken)
  }

  return await new Promise((resolve, reject) => {
    const exportEnv = buildCliEnv(sourceToken, { ssl: sourceConfig.ssl })
    const importEnv = buildCliEnv(targetToken, { ssl: targetConfig.ssl })
    // Disable foreign-key trigger checks for this import session only. Each psql
    // invocation is a fresh session, so SET from executePsqlCommand does not carry
    // over to the COPY process below.
    importEnv.PGOPTIONS = `${process.env.PGOPTIONS ? process.env.PGOPTIONS + ' ' : ''}-c session_replication_role=replica`
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

    const exportStream = spawn('psql', exportArgs, { env: exportEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    const importStream = spawn('psql', importArgs, { env: importEnv, stdio: ['pipe', 'pipe', 'pipe'] })

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

async function restoreDatabaseSchema (sourceConfig, sourceDbName, targetConfig, targetDbName, options = {}) {
  const { includeLiquibaseTables = false, extraExcludedTables = [], sourceToken, targetToken } = options

  if (!sourceToken) {
    throw new Error(`No authentication token available for source database ${sourceDbName}`)
  }
  if (!targetToken) {
    throw new Error(`No authentication token available for target database ${targetDbName}`)
  }

  console.log(`Restoring schema-only dump from ${sourceDbName} to ${targetDbName}...`)

  return await new Promise((resolve, reject) => {
    const dumpArgs = buildPgDumpArgs(sourceConfig, sourceDbName, { includeLiquibaseTables, extraExcludedTables })
    dumpArgs.push('--schema-only')

    const restoreArgs = [
      '-h', targetConfig.host,
      '-p', String(targetConfig.port || 5432),
      '-U', targetConfig.username,
      '-d', targetDbName,
      '-w',
      '--set=ON_ERROR_STOP=1'
    ]

    let bytesTransferred = 0
    let dumpStderr = ''
    const dump = spawn('pg_dump', dumpArgs, { env: buildCliEnv(sourceToken, { ssl: sourceConfig.ssl }), stdio: ['ignore', 'pipe', 'pipe'] })
    const restore = spawn('psql', restoreArgs, { env: buildCliEnv(targetToken, { ssl: targetConfig.ssl }), stdio: ['pipe', 'pipe', 'pipe'] })
    const sanitizer = createDumpSanitizer()

    dump.stdout.on('data', chunk => {
      bytesTransferred += chunk.length
      if (bytesTransferred % (10 * 1024 * 1024) < chunk.length) {
        console.log(`  Schema dump transferred ${formatBytes(bytesTransferred)}...`)
      }
      if (!sanitizer.destroyed) {
        const canContinue = sanitizer.write(chunk)
        if (!canContinue) {
          dump.stdout.pause()
          sanitizer.once('drain', () => dump.stdout.resume())
        }
      }
    })

    sanitizer.on('data', chunk => {
      if (!restore.stdin.destroyed) {
        const canContinue = restore.stdin.write(chunk)
        if (!canContinue) {
          sanitizer.pause()
          restore.stdin.once('drain', () => sanitizer.resume())
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
        reject(new Error(`pg_dump schema-only failed for ${sourceDbName} with exit code ${code}. ${dumpStderr.trim()}`))
        return
      }
      sanitizer.end()
    })

    sanitizer.on('end', () => {
      restore.stdin.end()
    })

    restore.stderr.on('data', chunk => {
      process.stderr.write(`[psql] ${chunk.toString()}`)
    })

    restore.on('error', error => reject(error))
    restore.on('close', code => {
      if (code !== 0) {
        reject(new Error(`psql schema restore failed for ${targetDbName} with exit code ${code}`))
        return
      }
      console.log(`Restored schema-only dump (${formatBytes(bytesTransferred)})`)
      resolve({ restored: true, bytesTransferred })
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
  const { sourceEnvironment, targetEnvironment, sourceToken, targetToken, dryRun = false, dataOnly = false } = options
  const results = []
  let totalRows = 0

  const dependencies = await getForeignKeyDependencies(sourceConfig, sourceDbName, sourceToken)
  const orderedTableNames = sortTablesByDependencies(tableNames, dependencies)

  if (process.env.DEBUG_TRANSFER_ORDER) {
    console.log('Dependency edges:')
    for (const { tableName, referencedTableName } of dependencies) {
      console.log(`  ${tableName} -> ${referencedTableName}`)
    }
    console.log('Copy order:')
    for (let i = 0; i < orderedTableNames.length; i++) {
      console.log(`  ${i + 1}. ${orderedTableNames[i]}`)
    }
  }

  console.log(`Copying ${orderedTableNames.length} table(s) individually`)

  for (let i = 0; i < orderedTableNames.length; i++) {
    const tableName = orderedTableNames[i]
    console.log(`[${i + 1}/${orderedTableNames.length}] Copying table ${tableName}`)

    if (dryRun) {
      console.log(`[DRY RUN] Would copy ${tableName}`)
      results.push({ tableName, restored: true, dryRun: true })
      continue
    }

    const currentSourceToken = sourceEnvironment ? await refreshToken(sourceEnvironment) : sourceToken
    const currentTargetToken = targetEnvironment ? await refreshToken(targetEnvironment) : targetToken

    const result = await copyTableRows(sourceConfig, sourceDbName, targetConfig, targetDbName, tableName, currentSourceToken, currentTargetToken, { dataOnly })
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

    if (tableByTable || largeTables.length > 0) {
      console.log('Using table-by-table copy mode for better progress visibility and memory safety')
      await restoreDatabaseSchema(sourceConfig, sourceDbName, targetConfig, targetDbName, {
        includeLiquibaseTables,
        sourceToken: sourceConnection.token,
        targetToken: targetConnection.token
      })
      const { results, totalRows } = await streamTableByTable(
        sourceConfig,
        sourceDbName,
        targetConfig,
        targetDbName,
        tableSizes.map(t => t.tableName),
        { sourceEnvironment, targetEnvironment, dryRun: false, dataOnly: true }
      )
      return { sourceDbName, targetDbName, dryRun: false, copied: true, tableByTable: true, tableCount: results.length, totalRows }
    }

    await truncateTargetTablesExceptProtected(targetDbName, targetEnvironment, { preserveLiquibaseTables: true })

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
        const dump = spawn('pg_dump', dumpArgs, { env: buildCliEnv(sourceConnection.token, { ssl: sourceConnection.config.ssl }), stdio: ['ignore', 'pipe', 'pipe'] })
        const restore = spawn('psql', restoreArgs, { env: buildCliEnv(targetConnection.token, { ssl: targetConnection.config.ssl }), stdio: ['pipe', 'pipe', 'pipe'] })
        const sanitizer = createDumpSanitizer()

        dump.stdout.on('data', chunk => {
          bytesTransferred += chunk.length
          if (bytesTransferred % (10 * 1024 * 1024) < chunk.length) {
            console.log(`Transferred ${formatBytes(bytesTransferred)}...`)
          }
          if (!sanitizer.destroyed) {
            const canContinue = sanitizer.write(chunk)
            if (!canContinue) {
              dump.stdout.pause()
              sanitizer.once('drain', () => dump.stdout.resume())
            }
          }
        })

        sanitizer.on('data', chunk => {
          if (!restore.stdin.destroyed) {
            const canContinue = restore.stdin.write(chunk)
            if (!canContinue) {
              sanitizer.pause()
              restore.stdin.once('drain', () => sanitizer.resume())
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
          sanitizer.end()
        })

        sanitizer.on('end', () => {
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

          const dump = spawn('pg_dump', fallbackDumpArgs, { env: buildCliEnv(sourceConnection.token, { ssl: sourceConnection.config?.ssl }), stdio: ['ignore', 'pipe', 'pipe'] })
          const restore = spawn('psql', restoreArgs, { env: buildCliEnv(targetConnection.token, { ssl: targetConnection.config?.ssl }), stdio: ['pipe', 'pipe', 'pipe'] })
          const sanitizer = createDumpSanitizer()

          dump.stdout.on('data', chunk => {
            if (!sanitizer.destroyed) {
              const canContinue = sanitizer.write(chunk)
              if (!canContinue) {
                dump.stdout.pause()
                sanitizer.once('drain', () => dump.stdout.resume())
              }
            }
          })

          sanitizer.on('data', chunk => {
            if (!restore.stdin.destroyed) {
              const canContinue = restore.stdin.write(chunk)
              if (!canContinue) {
                sanitizer.pause()
                restore.stdin.once('drain', () => sanitizer.resume())
              }
            }
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
            sanitizer.end()
          })

          sanitizer.on('end', () => {
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

async function resetSequencesAfterTransfer (targetConfig, targetDbName, targetToken) {
  console.log('Resetting sequences to match imported data...')
  const sql = `
    DO $$
    DECLARE
      rec record;
      current_max bigint;
      seq_last_value bigint;
      new_start bigint;
    BEGIN
      FOR rec IN
        SELECT
          s.relname AS sequence_name,
          t.relname AS table_name,
          a.attname AS column_name
        FROM pg_class s
        JOIN pg_depend dep ON dep.objid = s.oid AND dep.refobjsubid != 0
        JOIN pg_class t ON t.oid = dep.refobjid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = dep.refobjsubid
        WHERE s.relkind = 'S'
          AND t.relnamespace = 'public'::regnamespace
      LOOP
        EXECUTE format('SELECT last_value FROM %I', rec.sequence_name) INTO seq_last_value;
        EXECUTE format('SELECT coalesce(max(%I), 0) FROM %I', rec.column_name, rec.table_name) INTO current_max;

        IF current_max = 0 THEN
          CONTINUE;
        END IF;

        new_start := current_max + 1;

        IF seq_last_value >= new_start THEN
          CONTINUE;
        END IF;

        EXECUTE format('SELECT setval(%L, %s, false)', rec.sequence_name, new_start);
        RAISE NOTICE 'Reset sequence % on %.% to %', rec.sequence_name, rec.table_name, rec.column_name, new_start;
      END LOOP;
    END $$;
  `
  await executePsqlCommand(targetConfig, targetDbName, sql, targetToken)
  console.log('Sequence reset complete.')
}

async function runTransferHealthCheck (targetConfig, targetDbName, targetToken) {
  const sql = `
    DO $$
    DECLARE
      rec record;
      seq_last_value bigint;
      current_max bigint;
      issue_count integer := 0;
    BEGIN
      -- sequences behind current data
      FOR rec IN
        SELECT
          s.relname AS sequence_name,
          t.relname AS table_name,
          a.attname AS column_name
        FROM pg_class s
        JOIN pg_depend dep ON dep.objid = s.oid AND dep.refobjsubid != 0
        JOIN pg_class t ON t.oid = dep.refobjid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = dep.refobjsubid
        WHERE s.relkind = 'S'
          AND t.relnamespace = 'public'::regnamespace
      LOOP
        EXECUTE format('SELECT last_value FROM %I', rec.sequence_name) INTO seq_last_value;
        EXECUTE format('SELECT coalesce(max(%I), 0) FROM %I', rec.column_name, rec.table_name) INTO current_max;

        IF seq_last_value < current_max THEN
          issue_count := issue_count + 1;
          RAISE WARNING 'sequence behind: % on %.% (last_value=%, max=%)',
            rec.sequence_name, rec.table_name, rec.column_name, seq_last_value, current_max;
        END IF;
      END LOOP;

      -- tables missing primary key
      FOR rec IN
        SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r'
          AND n.nspname = 'public'
          AND NOT EXISTS (
            SELECT 1 FROM pg_constraint con
            WHERE con.conrelid = c.oid AND con.contype = 'p'
          )
      LOOP
        issue_count := issue_count + 1;
        RAISE WARNING 'missing primary key: %', rec.table_name;
      END LOOP;

      -- foreign keys without supporting index
      FOR rec IN
        SELECT
          c.conrelid::regclass::text AS table_name,
          c.conname AS fk_name,
          (
            SELECT string_agg(a.attname, ', ' ORDER BY ord.n)
            FROM unnest(c.conkey) WITH ORDINALITY AS ord(attnum, n)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ord.attnum
          ) AS fk_columns
        FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.connamespace = 'public'::regnamespace
          AND NOT EXISTS (
            SELECT 1 FROM pg_index i
            WHERE i.indrelid = c.conrelid
              AND (i.indkey::int4[])[0:array_length(c.conkey,1)-1] @> c.conkey::int4[]
          )
      LOOP
        issue_count := issue_count + 1;
        RAISE WARNING 'foreign key without index: % on % (columns: %)', rec.fk_name, rec.table_name, rec.fk_columns;
      END LOOP;

      -- invalid indexes
      FOR rec IN
        SELECT indrelid::regclass::text AS table_name, indexrelid::regclass::text AS index_name
        FROM pg_index
        WHERE NOT indisvalid
      LOOP
        issue_count := issue_count + 1;
        RAISE WARNING 'invalid index: % on %', rec.index_name, rec.table_name;
      END LOOP;

      -- unvalidated foreign keys
      FOR rec IN
        SELECT conrelid::regclass::text AS table_name, conname AS fk_name
        FROM pg_constraint
        WHERE contype = 'f'
          AND NOT convalidated
          AND connamespace = 'public'::regnamespace
      LOOP
        issue_count := issue_count + 1;
        RAISE WARNING 'unvalidated foreign key: % on %', rec.fk_name, rec.table_name;
      END LOOP;

      IF issue_count = 0 THEN
        RAISE NOTICE 'transfer health check passed: no issues found';
      ELSE
        RAISE EXCEPTION 'transfer health check failed: % issue(s) found', issue_count;
      END IF;
    END $$;
  `
  await executePsqlCommand(targetConfig, targetDbName, sql, targetToken)
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
  copyDatabaseStream,
  restoreDatabaseSchema,
  getTableSchemaDump,
  copyTableRows,
  executePsqlCommand,
  getForeignKeyDependencies,
  sortTablesByDependencies,
  resetSequencesAfterTransfer,
  runTransferHealthCheck
}
