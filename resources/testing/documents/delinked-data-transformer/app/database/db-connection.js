const { Pool } = require('pg')
const { DefaultAzureCredential } = require('@azure/identity')

/**
 * Creates an enhanced database connection with the broadest possible permissions
 * @param {string} database - Database name to connect to
 * @param {Object} options - Additional connection options
 * @returns {Promise<Object>} Database connection object
 */
async function createConnection(database = 'postgres', options = {}) {
  if (!process.env.POSTGRES_DEV_HOST) {
    throw new Error('POSTGRES_DEV_HOST environment variable is required')
  }

  // Get an enhanced Azure credential with broader permissions
  const token = await getEnhancedAzureToken()
  
  const username = process.env.POSTGRES_DEV_ADMIN || process.env.POSTGRES_USER
  
  const config = {
    user: username,
    password: token,
    host: process.env.POSTGRES_DEV_HOST,
    port: process.env.POSTGRES_PORT || 5432,
    database,
    ssl: true,
    max: options.max || 10,
    keepAlive: true,
    idleTimeoutMillis: options.idleTimeoutMillis || 30000,
    connectionTimeoutMillis: options.connectionTimeoutMillis || 30000,
    application_name: 'database_dump'
  }

  console.log(`Connecting to ${process.env.POSTGRES_DEV_HOST}/${database} as ${username}`)

  const pool = new Pool(config)

  pool.on('error', err => {
    console.error(`Unexpected error on client for ${database}`, err)
  })

  try {
    const client = await pool.connect()
    console.log(`Connected to PostgreSQL database "${database}" using Azure AD authentication`)
    client.release()

    return {
      query: async (text, params) => await pool.query(text, params),
      pool,
      database,
      config: {
        host: process.env.POSTGRES_DEV_HOST,
        port: process.env.POSTGRES_PORT || 5432,
        database,
        username
      },
      token
    }
  } catch (err) {
    console.error(`Error connecting to the database "${database}":`, err.stack)
    throw err
  }
}

/**
 * Get an Azure token with the broadest possible permissions for database operations
 * @returns {Promise<string>} Azure authentication token
 */
async function getEnhancedAzureToken() {
  // Try multiple strategies for getting the most permissive token
  try {
    // Strategy 1: Enhanced DefaultAzureCredential with broader scope
    const credential = new DefaultAzureCredential({
      tenantId: process.env.DEV_TENANT_ID,
      managedIdentityClientId: process.env.AZURE_CLIENT_ID,
      excludeEnvironmentCredential: false,
      excludeInteractiveBrowserCredential: false,
      disableInstanceDiscovery: false
    });
    
    // Request token with broader database scope
    const token = await credential.getToken('https://ossrdbms-aad.database.windows.net/.default');
    console.log('Successfully obtained enhanced Azure authentication token');
    return token.token;
  } catch (error) {
    console.error('Error getting enhanced Azure token:', error.message);
    
    // Strategy 2: Default credential with basic scope
    try {
      const credential = new DefaultAzureCredential({
        tenantId: process.env.DEV_TENANT_ID
      });
      
      const token = await credential.getToken('https://ossrdbms-aad.database.windows.net');
      console.log('Successfully obtained basic Azure authentication token');
      return token.token;
    } catch (fallbackError) {
      console.error('Error getting Azure token (fallback):', fallbackError.message);
      throw new Error('Failed to authenticate with Azure: ' + fallbackError.message);
    }
  }
}

/**
 * List all databases matching specified patterns in a single query
 * @param {Array<string>} patterns - SQL LIKE patterns to match database names
 * @returns {Promise<Array<string>>} Array of database names
 */
async function listDatabases(patterns = null) {
  const connection = await createConnection('postgres')

  if (!patterns) {
    // Default FFC patterns
    patterns = ['ffc-doc-%-dev', 'ffc-doc-%-test', 'ffc-pay-%-dev', 'ffc-pay-%-test']
  }

  try {
    const placeholders = patterns.map((_, i) => `datname LIKE $${i + 1}`).join(' OR ')
    const query = `SELECT datname FROM pg_database WHERE ${placeholders} ORDER BY datname`

    const { rows } = await connection.query(query, patterns)
    const databases = rows.map(row => row.datname)

    return databases
  } catch (err) {
    console.error(`Error listing databases: ${err.message}`)
    return []
  } finally {
    await connection?.pool?.end()
  }
}

/**
 * Get database statistics for monitoring and reporting
 * @param {Object} connection - Database connection from createConnection
 * @returns {Promise<Object>} Database statistics
 */
async function getDatabaseStats(connection) {
  try {
    // Get total database size
    const sizeResult = await connection.query(`
      SELECT pg_database_size($1) AS size
    `, [connection.database]);
    
    // Get table count
    const tableCountResult = await connection.query(`
      SELECT count(*) AS table_count 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    
    // Get top 5 largest tables for reporting
    const largeTablesResult = await connection.query(`
      SELECT 
        table_name, 
        pg_relation_size(quote_ident(table_schema) || '.' || quote_ident(table_name))/1024/1024 as size_mb
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY size_mb DESC
      LIMIT 5
    `);
    
    return {
      totalSizeMB: sizeResult.rows[0].size / 1024 / 1024,
      tableCount: parseInt(tableCountResult.rows[0].table_count),
      largeTables: largeTablesResult.rows
    };
  } catch (error) {
    console.error(`Error getting database stats: ${error.message}`);
    return { totalSizeMB: 0, tableCount: 0, largeTables: [] };
  }
}

async function getDevAndTestDatabases() {
  const allDatabases = await listDatabases()
  const devDatabases = allDatabases.filter(db => db.endsWith('-dev'))
  const testDatabases = allDatabases.filter(db => db.endsWith('-test'))

  return { devDatabases, testDatabases }
}

module.exports = {
  createConnection,
  listDatabases,
  getDevAndTestDatabases,
  getEnhancedAzureToken,
  getDatabaseStats
}

// Run standalone if executed directly
if (require.main === module) {
  (async () => {
    try {
      console.log('Testing database connection...')

      const { devDatabases, testDatabases } = await getDevAndTestDatabases()

      console.log('Found dev databases:', devDatabases.length)
      console.log(devDatabases)

      console.log('Found test databases:', testDatabases.length)
      console.log(testDatabases)

    } catch (error) {
      console.error('Error testing database connection:', error)
    }
  })()
}