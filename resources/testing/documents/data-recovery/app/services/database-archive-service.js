const crypto = require('crypto')
const fs = require('fs')
const { spawnSync } = require('child_process')

const VALID_SSL_MODES = new Set(['require', 'verify-ca', 'verify-full'])

function getEnvironmentValue (environment, keys) {
  for (const key of keys) {
    const value = environment[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
}

function getPgSslMode (databaseConfig, environment, side) {
  const source = side === 'source'
  const sslKeys = source
    ? ['RECOVERY_SOURCE_DB_SSL']
    : ['RECOVERY_TARGET_DB_SSL']
  const sslModeKeys = source
    ? ['RECOVERY_SOURCE_DB_SSL_MODE']
    : ['RECOVERY_TARGET_DB_SSL_MODE']
  const sslSetting = getEnvironmentValue(environment, sslKeys)

  if (sslSetting?.toLowerCase() === 'false' || !databaseConfig.ssl) {
    return 'disable'
  }

  const configuredMode = getEnvironmentValue(environment, sslModeKeys)
  if (configuredMode === 'no-verify') {
    return 'require'
  }

  const mode = configuredMode || (databaseConfig.ssl === true ? 'require' : 'verify-full')
  if (!VALID_SSL_MODES.has(mode)) {
    throw new Error(`Unsupported PostgreSQL SSL mode "${mode}"`)
  }
  return mode
}

function buildConnectionArgs (databaseConfig) {
  const required = ['host', 'port', 'user', 'password', 'database']
  const missing = required.filter(key => databaseConfig[key] === undefined || databaseConfig[key] === null || databaseConfig[key] === '')
  if (missing.length > 0) {
    throw new Error(`Missing PostgreSQL connection settings: ${missing.join(', ')}`)
  }

  return [
    '--host', String(databaseConfig.host),
    '--port', String(databaseConfig.port),
    '--username', String(databaseConfig.user),
    '--dbname', String(databaseConfig.database),
    '--no-password'
  ]
}

function buildToolEnvironment (databaseConfig, sslMode, environment = process.env) {
  return {
    ...environment,
    PGHOST: String(databaseConfig.host),
    PGPORT: String(databaseConfig.port),
    PGUSER: String(databaseConfig.user),
    PGPASSWORD: String(databaseConfig.password),
    PGSSLMODE: sslMode
  }
}

function parsePgMajorVersion (versionString) {
  const match = /PostgreSQL\)\s+(\d+)(?:\.(\d+))?/.exec(versionString)
  if (!match) {
    throw new Error(`Could not read PostgreSQL version from "${versionString}"`)
  }

  const major = Number(match[1])
  return major >= 10 ? major : Number(`${major}.${match[2] || 0}`)
}

function parseServerMajorVersion (versionNumber) {
  const numericVersion = Number(versionNumber)
  if (!Number.isInteger(numericVersion) || numericVersion <= 0) {
    throw new Error(`Invalid PostgreSQL server version number "${versionNumber}"`)
  }

  if (numericVersion >= 100000) {
    return Math.floor(numericVersion / 10000)
  }

  const major = Math.floor(numericVersion / 10000)
  const minor = Math.floor((numericVersion % 10000) / 100)
  return Number(`${major}.${minor}`)
}

function quoteIdentifier (identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`
}

function quoteLiteral (value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function buildCreateDatabaseSql (databaseName, metadata, serverMajor, owner) {
  if (!metadata.encoding) {
    throw new Error('The source database encoding is missing from the archive metadata')
  }

  const options = [
    'TEMPLATE template0',
    `ENCODING = ${quoteLiteral(metadata.encoding)}`
  ]
  if (owner) options.push(`OWNER ${quoteIdentifier(owner)}`)

  if (metadata.localeProvider === 'icu') {
    if (serverMajor < 15 || !metadata.icuLocale) {
      throw new Error('The target PostgreSQL server cannot create a database with the source ICU locale')
    }
    options.push('LOCALE_PROVIDER = icu', `ICU_LOCALE = ${quoteLiteral(metadata.icuLocale)}`)
  } else if (metadata.localeProvider === 'libc' || !metadata.localeProvider) {
    if (!metadata.collation || !metadata.ctype) {
      throw new Error('The source database libc locale is incomplete in the archive metadata')
    }
    if (serverMajor >= 15) {
      options.push('LOCALE_PROVIDER = libc')
    }
    options.push(
      `LC_COLLATE = ${quoteLiteral(metadata.collation)}`,
      `LC_CTYPE = ${quoteLiteral(metadata.ctype)}`
    )
  } else {
    throw new Error(`Unsupported source locale provider "${metadata.localeProvider}"`)
  }

  return `CREATE DATABASE ${quoteIdentifier(databaseName)} WITH ${options.join(' ')}`
}

function createTemporaryDatabaseName (targetDatabase, purpose, token) {
  const suffix = `_${purpose}_${token}`
  const prefix = String(targetDatabase).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 63 - suffix.length)
  return `${prefix}${suffix}`
}

function getTargetConfirmation (databaseConfig) {
  return `${databaseConfig.host}:${databaseConfig.port}/${databaseConfig.database}`
}

function assertRestoreConfirmation (databaseConfig, options = {}) {
  if (options.wipe !== true) {
    throw new Error('Restore requires --wipe because the target database will be replaced')
  }

  const expected = getTargetConfirmation(databaseConfig)
  if (options.confirmTarget !== expected) {
    throw new Error(`Restore requires --confirm-target "${expected}" to match the configured target`)
  }
  return expected
}

function assertRestoreCompatibility (versions) {
  if (versions.pgDumpMajor < versions.sourceMajor) {
    throw new Error(`pg_dump ${versions.pgDumpMajor} is older than source PostgreSQL ${versions.sourceMajor}`)
  }
  const archiveDumpMajor = versions.archiveDumpMajor || versions.pgDumpMajor
  if (versions.pgDumpMajor !== archiveDumpMajor) {
    throw new Error(`pg_dump ${versions.pgDumpMajor} does not match the archive client ${archiveDumpMajor}`)
  }
  if (versions.pgRestoreMajor < archiveDumpMajor) {
    throw new Error(`pg_restore ${versions.pgRestoreMajor} is older than the archive client ${archiveDumpMajor}`)
  }
  if (versions.targetMajor !== versions.sourceMajor) {
    throw new Error(`Source PostgreSQL ${versions.sourceMajor} and target PostgreSQL ${versions.targetMajor} must use the same major version`)
  }
}

function isSameDatabase (sourceIdentity, targetIdentity, sourceConfig, targetConfig) {
  if (String(sourceIdentity.database).toLowerCase() !== String(targetConfig.database).toLowerCase()) {
    return false
  }

  const normalizeHost = host => String(host || '').trim().toLowerCase().replace(/\.$/, '')
  const configuredEndpointMatches = normalizeHost(sourceConfig.host) === normalizeHost(targetConfig.host) &&
    Number(sourceConfig.port) === Number(targetConfig.port)
  const reportedEndpointMatches = sourceIdentity.serverAddress && targetIdentity.serverAddress &&
    normalizeHost(sourceIdentity.serverAddress) === normalizeHost(targetIdentity.serverAddress) &&
    Number(sourceIdentity.serverPort) === Number(targetIdentity.serverPort)

  return configuredEndpointMatches || reportedEndpointMatches
}

async function readDatabaseMetadata (connection) {
  const { rows } = await connection.query(`
    SELECT current_database() AS database,
           inet_server_addr()::text AS server_address,
           inet_server_port() AS server_port,
           version() AS server_version,
           current_setting('server_version_num')::integer AS server_version_num,
           pg_encoding_to_char(d.encoding) AS encoding,
           d.datcollate AS collation,
           d.datctype AS ctype
    FROM pg_database d
    WHERE d.datname = current_database()
  `)

  if (!rows[0]) throw new Error('Could not read PostgreSQL database metadata')

  const metadata = {
    database: rows[0].database,
    serverAddress: rows[0].server_address,
    serverPort: Number(rows[0].server_port),
    serverVersion: rows[0].server_version,
    serverVersionNum: Number(rows[0].server_version_num),
    serverMajor: parseServerMajorVersion(rows[0].server_version_num),
    encoding: rows[0].encoding,
    collation: rows[0].collation,
    ctype: rows[0].ctype,
    localeProvider: 'libc',
    icuLocale: null,
    collationVersion: null,
    actualCollationVersion: null
  }

  if (metadata.serverMajor >= 13) {
    const { rows: versionRows } = await connection.query(`
      SELECT d.datcollversion AS collation_version,
             pg_database_collation_actual_version(d.oid) AS actual_collation_version
      FROM pg_database d
      WHERE d.datname = current_database()
    `)
    metadata.collationVersion = versionRows[0]?.collation_version || null
    metadata.actualCollationVersion = versionRows[0]?.actual_collation_version || null
  }

  if (metadata.serverMajor >= 15) {
    const { rows: localeRows } = await connection.query(`
      SELECT datlocprovider AS locale_provider, daticulocale AS icu_locale
      FROM pg_database
      WHERE datname = current_database()
    `)
    const provider = localeRows[0]?.locale_provider
    metadata.localeProvider = provider === 'i' ? 'icu' : provider === 'c' ? 'libc' : provider === 'b' ? 'builtin' : null
    metadata.icuLocale = localeRows[0]?.icu_locale || null
  }

  return metadata
}

async function getDatabaseInventory (connection) {
  const { rows } = await connection.query(`
    SELECT n.nspname AS schema_name, c.relname AS relation_name, c.relkind AS relation_kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'm', 'f')
      AND n.nspname <> 'information_schema'
      AND n.nspname !~ '^pg_'
      AND c.relpersistence <> 't'
    ORDER BY n.nspname, c.relname
  `)

  return rows.map(row => ({
    schema: row.schema_name,
    name: row.relation_name,
    kind: row.relation_kind
  }))
}

async function getExactDataCounts (connection, inventory) {
  const dataRelations = inventory.filter(relation => ['r', 'm'].includes(relation.kind))
  const counts = []

  for (const relation of dataRelations) {
    const identifier = `${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.name)}`
    const only = relation.kind === 'r' ? 'ONLY ' : ''
    const { rows } = await connection.query(`SELECT count(*)::text AS count FROM ${only}${identifier}`)
    counts.push({ schema: relation.schema, name: relation.name, count: rows[0].count })
  }

  const { rows } = await connection.query('SELECT count(*)::text AS count FROM pg_largeobject_metadata')
  counts.push({ schema: '', name: '$large_objects', count: rows[0].count })
  return counts
}

async function getDatabaseExtensions (connection) {
  const { rows } = await connection.query(`
    SELECT extname AS name, extversion AS version
    FROM pg_extension
    ORDER BY extname
  `)
  return rows.map(row => ({ name: row.name, version: row.version }))
}

function runPgTool (command, args, options = {}) {
  const result = spawnSync(command, args, {
    env: options.environment,
    stdio: options.stdio || ['ignore', 'inherit', 'inherit'],
    encoding: 'utf8',
    windowsHide: true
  })

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error(`${command} is not installed; install PostgreSQL client tools`)
    }
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(`${command} failed${result.signal ? ` with signal ${result.signal}` : ` with exit code ${result.status}`}`)
  }

  return result
}

function getPgToolVersion (command) {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true
  })

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error(`${command} is not installed; install PostgreSQL client tools`)
    }
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`${command} --version failed with exit code ${result.status}`)
  }

  return result.stdout.trim()
}

async function hashFile (filePath) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

async function hashSchemaDumpFile (filePath) {
  const hash = crypto.createHash('sha256')
  let pending = ''
  const hashLine = line => {
    const normalized = normalizeSchemaDumpLine(line)
    if (normalized !== null) hash.update(`${normalized}\n`)
  }

  for await (const chunk of fs.createReadStream(filePath, { encoding: 'utf8' })) {
    const lines = (pending + chunk).split('\n')
    pending = lines.pop()
    for (const line of lines) hashLine(line)
  }

  if (pending) hashLine(pending)
  return hash.digest('hex')
}

function normalizeSchemaDumpLine (line) {
  const normalized = line.endsWith('\r') ? line.slice(0, -1) : line
  if (!normalized.trim() || /^\\(?:un)?restrict\b/.test(normalized) || /^\s*--/.test(normalized)) return null
  if (/^SET default_table_access_method = (?:"heap"|'heap'|heap);$/i.test(normalized)) return null
  if (normalized === 'COMMENT ON SCHEMA "public" IS \'standard public schema\';') return null
  return normalized
}

function findFirstSchemaDumpDifference (sourcePath, targetPath) {
  const sourceLines = fs.readFileSync(sourcePath, 'utf8')
    .split('\n')
    .map(normalizeSchemaDumpLine)
    .filter(line => line !== null)
  const targetLines = fs.readFileSync(targetPath, 'utf8')
    .split('\n')
    .map(normalizeSchemaDumpLine)
    .filter(line => line !== null)
  const lineCount = Math.max(sourceLines.length, targetLines.length)

  for (let index = 0; index < lineCount; index++) {
    if (sourceLines[index] !== targetLines[index]) {
      const source = sourceLines[index] ?? '<end of file>'
      const target = targetLines[index] ?? '<end of file>'
      return {
        line: index + 1,
        source: source.slice(0, 400),
        target: target.slice(0, 400)
      }
    }
  }

  return null
}

function compareDatabaseLocales (source, target) {
  const fields = ['encoding', 'collation', 'ctype', 'localeProvider', 'icuLocale']
  const differences = fields
    .filter(field => source[field] !== target[field])
    .map(field => `${field}: source=${source[field] ?? 'none'}, target=${target[field] ?? 'none'}`)

  return {
    compatible: differences.length === 0,
    differences,
    collationVersionDiffers: Boolean(
      source.actualCollationVersion &&
      target.actualCollationVersion &&
      source.actualCollationVersion !== target.actualCollationVersion
    )
  }
}

function compareDatabaseExtensions (sourceExtensions, targetExtensions) {
  const sourceVersions = new Map(sourceExtensions.map(extension => [extension.name, extension.version]))
  const targetVersions = new Map(targetExtensions.map(extension => [extension.name, extension.version]))
  const names = [...new Set([...sourceVersions.keys(), ...targetVersions.keys()])].sort()
  const missingOrUnexpected = names
    .filter(name => !sourceVersions.has(name) || !targetVersions.has(name))
    .map(name => `${name}: source=${sourceVersions.get(name) || 'missing'}, staging=${targetVersions.get(name) || 'missing'}`)
  const versionDifferences = names
    .filter(name => sourceVersions.has(name) && targetVersions.has(name) && sourceVersions.get(name) !== targetVersions.get(name))
    .map(name => `${name}: source=${sourceVersions.get(name)}, staging=${targetVersions.get(name)}`)

  return {
    compatible: missingOrUnexpected.length === 0,
    differences: missingOrUnexpected,
    versionDifferences
  }
}

module.exports = {
  getPgSslMode,
  buildConnectionArgs,
  buildToolEnvironment,
  parsePgMajorVersion,
  parseServerMajorVersion,
  quoteIdentifier,
  quoteLiteral,
  buildCreateDatabaseSql,
  createTemporaryDatabaseName,
  getTargetConfirmation,
  assertRestoreConfirmation,
  assertRestoreCompatibility,
  isSameDatabase,
  readDatabaseMetadata,
  getDatabaseInventory,
  getExactDataCounts,
  getDatabaseExtensions,
  compareDatabaseLocales,
  compareDatabaseExtensions,
  runPgTool,
  getPgToolVersion,
  hashFile,
  hashSchemaDumpFile,
  findFirstSchemaDumpDifference
}
