const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { createConnection, listDatabases } = require('./db-connection')
const os = require('os')

// Set maximum concurrency based on CPUs, but limit to avoid overwhelming the server
const MAX_CONCURRENT_DATABASES = Math.min(os.cpus().length, 4)

/**
 * Dumps all databases in a highly optimized manner with concurrency
 */
async function dumpAllTestTables() {
  console.log(`Running with concurrency: Up to ${MAX_CONCURRENT_DATABASES} databases in parallel`)
  
  const dumpDir = path.resolve(process.cwd(), '../../dumps')
  fs.mkdirSync(dumpDir, { recursive: true })

  const token = await getAzureAuthToken()
  
  const dbPatterns = ['ffc-doc-%-test', 'ffc-pay-%-test']
  
  try {
    const databases = await listDatabases(dbPatterns)
    console.log(`Found ${databases.length} matching databases:`)
    databases.forEach(db => console.log(`  - ${db}`))

    for (let i = 0; i < databases.length; i += MAX_CONCURRENT_DATABASES) {
      const batch = databases.slice(i, i + MAX_CONCURRENT_DATABASES)
      console.log(`\nProcessing batch of ${batch.length} databases (${i+1}-${Math.min(i+MAX_CONCURRENT_DATABASES, databases.length)} of ${databases.length})`)
      
      await Promise.all(batch.map(database => processDatabase(database, dumpDir, token)))
    }
    
    console.log('\nAll test databases have been dumped successfully.')
  } catch (error) {
    console.error('Error in dumpAllTestTables:', error)
    throw error
  }
}

/**
 * Process a single database dump
 */
async function processDatabase(database, dumpDir, token) {
  console.log(`\nProcessing database: ${database}`)
  const dbConnection = await createConnection(database)
  
  try {
    const config = {
      host: process.env.POSTGRES_DEV_HOST,
      port: process.env.POSTGRES_PORT || 5432,
      database: database,
      username: dbConnection.pool.options.user
    }
    
    // Create directory for this database dumps
    const dbDumpDir = path.join(dumpDir, database)
    fs.mkdirSync(dbDumpDir, { recursive: true })
    
    // Full database dump with schema and data in plain SQL format
    const fullDumpPath = path.join(dbDumpDir, `${database}_full.sql`)
    await performFullDump(config, fullDumpPath, token)
    console.log(`Completed full dump of ${database} to ${fullDumpPath}`)
    
    return { database, success: true }
  } catch (error) {
    console.error(`Error processing database ${database}:`, error)
    return { database, success: false, error }
  } finally {
    if (dbConnection && dbConnection.pool) {
      await dbConnection.pool.end()
    }
  }
}

async function performFullDump(config, outputPath, token) {
  return new Promise((resolve, reject) => {
    try {
      const env = { ...process.env, PGPASSWORD: token };
      
      const args = [
        '-h', config.host,
        '-p', config.port,
        '-U', config.username,
        '-d', config.database,
        '--no-owner',        // Skip ownership commands
        '--no-privileges',   // Skip privilege commands for migration
        '--no-tablespaces',  // Skip tablespace assignments
        '--format=plain',    // Human-readable SQL format
        '--create',          // Include create database statement
        '--clean',           // Include drop statements
        '-f', outputPath
      ];
      
      const pgDump = spawn('pg_dump', args, { env });
      
      let stderrOutput = '';
      pgDump.stderr.on('data', (data) => {
        stderrOutput += data.toString();
        if (!data.toString().includes('dumping') && !data.toString().includes('processing')) {
          console.error(`pg_dump stderr (${config.database}): ${data}`);
        }
      });
      
      pgDump.on('close', (code) => {
        if (code === 0) {
          const stats = fs.statSync(outputPath);
          const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
          console.log(`Full dump for ${config.database} completed successfully (${fileSizeMB} MB)`);
          resolve();
        } else {
          reject(new Error(`pg_dump process for ${config.database} exited with code ${code}: ${stderrOutput}`));
        }
      });
      
      pgDump.on('error', (error) => {
        reject(new Error(`pg_dump process error for ${config.database}: ${error.message}`));
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function getAzureAuthToken() {
  const { DefaultAzureCredential } = require('@azure/identity');
  
  try {
    const credential = new DefaultAzureCredential({
      tenantId: process.env.DEV_TENANT_ID
    });
    
    // Request token with minimal scope for PostgreSQL access
    const token = await credential.getToken('https://ossrdbms-aad.database.windows.net');
    return token.token;
  } catch (error) {
    console.error('Error getting Azure token:', error.message);
    throw new Error('Failed to authenticate with Azure: ' + error.message);
  }
}

module.exports = { dumpAllTestTables }
// this code on each file will allow the file to be run directly for testing - likely to remove in prod but maybe it's useful for testing
if (require.main === module) {
  console.log('Starting database dump operation...');
  dumpAllTestTables()
    .then(() => {
      console.log('Database dump completed successfully');
    })
    .catch((error) => {
      console.error('Error during database dump:', error);
      process.exit(1);
    });
}