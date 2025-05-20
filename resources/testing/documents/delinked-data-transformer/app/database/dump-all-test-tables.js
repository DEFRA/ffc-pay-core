const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { createConnection, listDatabases, getDatabaseStats } = require('./db-connection')
const os = require('os')

// Set maximum concurrency based on CPUs, but limit to avoid overwhelming the server
const MAX_CONCURRENT_DATABASES = Math.min(os.cpus().length, 3) // Reduced from 4 to prevent throttling

/**
 * Dumps all databases in a highly optimized manner with concurrency
 * 
 * RESTORE INSTRUCTIONS for plain SQL dumps:
 * psql --dbname=<target_db> --file=<filename.sql>
 */
async function dumpAllTestTables() {
  console.log(`Running with concurrency: Up to ${MAX_CONCURRENT_DATABASES} databases in parallel`)
  
  const dumpDir = path.resolve(process.cwd(), '../../dumps')
  fs.mkdirSync(dumpDir, { recursive: true })
  
  try {
    // First get ALL databases to diagnose discovery issues
    console.log('--- Database Discovery Diagnostics ---')
    const allDatabases = await listDatabases(['%'])
    console.log(`Total databases on server: ${allDatabases.length}`)
    
    // Log all "ffc" databases to help troubleshoot pattern matching
    const allFfcDatabases = allDatabases.filter(db => db.toLowerCase().includes('ffc'))
    console.log('All FFC-related databases on server:')
    allFfcDatabases.forEach(db => console.log(`  - ${db}`))
    
    // Standard patterns for test databases - expand patterns to catch more
    const dbPatterns = ['ffc-doc-%-test', 'ffc-pay-%-test']
    console.log(`\nSearching for databases matching patterns: ${dbPatterns.join(', ')}`)
    
    const databases = await listDatabases(dbPatterns)
    console.log(`Found ${databases.length} matching databases:`)
    databases.forEach(db => console.log(`  - ${db}`))
    
    // Check for potential missing databases
    const missingDatabases = allFfcDatabases
      .filter(db => db.endsWith('-test'))
      .filter(db => !databases.includes(db))
    
    if (missingDatabases.length > 0) {
      console.warn('\n⚠️ WARNING: Some FFC test databases don\'t match the patterns:')
      missingDatabases.forEach(db => console.warn(`  - ${db} (will be skipped)`))
      console.warn('If these should be included, check database naming patterns')
    }

    for (let i = 0; i < databases.length; i += MAX_CONCURRENT_DATABASES) {
      const batch = databases.slice(i, i + MAX_CONCURRENT_DATABASES)
      console.log(`\nProcessing batch of ${batch.length} databases (${i+1}-${Math.min(i+MAX_CONCURRENT_DATABASES, databases.length)} of ${databases.length})`)
      
      // Process each batch serially to ensure consistent results
      const results = []
      for (const database of batch) {
        try {
          const result = await processDatabase(database, dumpDir)
          results.push(result)
        } catch (error) {
          console.error(`Batch processing error on database ${database}:`, error)
          results.push({ database, success: false, error })
        }
      }
      
      // Report any failures in the batch
      const failures = results.filter(r => !r.success)
      if (failures.length > 0) {
        console.error(`\n${failures.length} database(s) failed in this batch:`)
        failures.forEach(f => console.error(`  - ${f.database}: ${f.error}`))
      }
    }
    
    console.log('\nAll test databases have been processed.')
  } catch (error) {
    console.error('Error in dumpAllTestTables:', error)
    throw error
  }
}

/**
 * Process a single database dump
 */
async function processDatabase(database, dumpDir) {
  console.log(`\nProcessing database: ${database}`)
  const dbConnection = await createConnection(database)
  
  try {
    // Create directory for this database dumps
    const dbDumpDir = path.join(dumpDir, database)
    fs.mkdirSync(dbDumpDir, { recursive: true })
    
    // Full database dump with schema and data - use SQL file
    const fullDumpPath = path.join(dbDumpDir, `${database}_full.sql`)
    await performFullDump(dbConnection, fullDumpPath)
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

async function performFullDump(dbConnection, outputPath) {
  return new Promise(async (resolve, reject) => {
    try {
      const startTime = new Date();
      console.log(`[${startTime.toISOString()}] Starting dump of ${dbConnection.database}...`);
      
      // Get database stats for progress tracking
      const dbStats = await getDatabaseStats(dbConnection);
      console.log(`Database ${dbConnection.database} stats: ${(dbStats.totalSizeMB).toFixed(2)} MB, ${dbStats.tableCount} tables`);
      
      if (dbStats.largeTables.length > 0) {
        console.log('Largest tables:');
        // Fix: Ensure size_mb is properly converted to a number
        dbStats.largeTables.forEach(t => {
          try {
            const sizeInMB = parseFloat(t.size_mb);
            console.log(`  - ${t.table_name}: ${isNaN(sizeInMB) ? "size unknown" : sizeInMB.toFixed(2) + " MB"}`);
          } catch(err) {
            console.log(`  - ${t.table_name}: size unknown`);
          }
        });
      }
      
      const env = { ...process.env, PGPASSWORD: dbConnection.token };
      const config = dbConnection.config;
      
      // Make sure parent directory exists
      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      
      // Configure arguments for pg_dump with plain format
      const args = [
        '-h', config.host,
        '-p', config.port,
        '-U', config.username,
        '-d', config.database,
        '--no-owner',
        '--no-privileges', 
        '--no-tablespaces',
        // Use plain SQL format
        '--format=plain', 
        // Add encoding to make this readable
        '--encoding=UTF8',
        // Output file
        '--file', outputPath,
        // Add verbose output for diagnosing issues
        '--verbose' 
      ];
      
      if (dbStats.totalSizeMB > 500) { // For databases over 500MB
        args.push('--data-only');       // Only dump data, schema already created
      }
      
      const pgDump = spawn('pg_dump', args, { env });
      
      let stderrOutput = '';
      let lastProgressTime = Date.now();
      let processedTables = new Set();
      let currentTable = '';
      
      // Monitor dump progress
      const progressInterval = setInterval(() => {
        try {
          // For plain format, get the file size
          if (fs.existsSync(outputPath)) {
            const stats = fs.statSync(outputPath);
            const currentSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
            const elapsedSeconds = Math.round((Date.now() - startTime.getTime()) / 1000);
            const mbPerSecond = (currentSizeMB / Math.max(1, elapsedSeconds)).toFixed(2);
            
            // Estimate progress based on tables processed
            const percentComplete = Math.min(
              100, 
              Math.round((processedTables.size / Math.max(1, dbStats.tableCount)) * 100)
            );
            
            console.log(
              `[${new Date().toISOString()}] ${config.database}: ` + 
              `Progress: ${percentComplete}% (${processedTables.size}/${dbStats.tableCount} tables), ` +
              `Size: ${currentSizeMB} MB, Rate: ${mbPerSecond} MB/s` +
              (currentTable ? `, Current: ${currentTable}` : '')
            );
          }
        } catch (err) {
          // Ignore file stat errors during writing
          console.log(`Warning: Could not get file size: ${err.message}`);
        }
      }, 20000); // Check every 20 seconds
      
      // Detect stalled processes
      const stallCheckInterval = setInterval(() => {
        const timeSinceLastActivity = Date.now() - lastProgressTime;
        
        // If no activity for 5 minutes, consider it stalled
        if (timeSinceLastActivity > 5 * 60 * 1000) {
          console.error(`[${new Date().toISOString()}] WARNING: Dump for ${config.database} appears stalled - no activity for ${Math.round(timeSinceLastActivity/1000)}s`);
          
          // Try to get more diagnostic info from the server
          if (pgDump && pgDump.pid) {
            console.log(`Attempting to diagnose stalled dump process (PID: ${pgDump.pid})...`);
            // Add any PostgreSQL specific diagnostics here
          }
        }
      }, 60000); // Check every minute
      
      pgDump.stderr.on('data', (data) => {
        const message = data.toString();
        stderrOutput += message;
        lastProgressTime = Date.now();
        
        // Track table progress from pg_dump output
        if (message.includes('dumping contents of table')) {
          const tableMatch = message.match(/dumping contents of table "?([^"\s]+)"?/);
          if (tableMatch && tableMatch[1]) {
            currentTable = tableMatch[1];
            processedTables.add(currentTable);
            
            // Only log every few tables to avoid flooding the console
            if (processedTables.size % 5 === 0 || processedTables.size === 1) {
              console.log(`[${new Date().toISOString()}] ${config.database}: ${message.trim()} (${processedTables.size}/${dbStats.tableCount})`);
            }
          }
        } else if (message.includes('error:')) {
          // Always log errors
          console.error(`[${new Date().toISOString()}] ERROR in ${config.database}: ${message.trim()}`);
        }
      });
      
      pgDump.stdout.on('data', (data) => {
        // Update last activity time even if we don't log stdout
        lastProgressTime = Date.now();
      });
      
      pgDump.on('close', (code) => {
        clearInterval(progressInterval);
        clearInterval(stallCheckInterval); // Clear stall detection
        clearTimeout(dumpTimeout);
        const endTime = new Date();
        const elapsedSeconds = Math.round((endTime.getTime() - startTime.getTime()) / 1000);
        
        if (code === 0) {
          try {
            // For file format, get file size
            const stats = fs.statSync(outputPath);
            const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
            const compressionRatio = dbStats.totalSizeMB > 0 ? 
              (dbStats.totalSizeMB / parseFloat(fileSizeMB)).toFixed(2) : 'unknown';
            
            console.log(
              `[${endTime.toISOString()}] Full dump for ${config.database} completed successfully:\n` +
              `  - File size: ${fileSizeMB} MB (compression ratio: ${compressionRatio}x)\n` +
              `  - Duration: ${elapsedSeconds}s (${(parseFloat(fileSizeMB) / Math.max(1, elapsedSeconds)).toFixed(2)} MB/s)\n` +
              `  - Tables processed: ${processedTables.size}/${dbStats.tableCount}`
            );
            resolve();
          } catch (err) {
            console.error(`Warning: Could not get final file size: ${err.message}`);
            console.log(`[${endTime.toISOString()}] Full dump for ${config.database} completed successfully`);
            resolve();
          }
        } else {
          console.error(`[${endTime.toISOString()}] FAILED: pg_dump for ${config.database} exited with code ${code} after ${elapsedSeconds}s`);
          reject(new Error(`pg_dump process for ${config.database} exited with code ${code}: ${stderrOutput}`));
        }
      });
      
      pgDump.on('error', (error) => {
        clearInterval(progressInterval);
        clearInterval(stallCheckInterval); // Clear stall detection
        clearTimeout(dumpTimeout);
        console.error(`[${new Date().toISOString()}] ERROR: pg_dump process error for ${config.database}: ${error.message}`);
        reject(new Error(`pg_dump process error for ${config.database}: ${error.message}`));
      });
      
      // Add a timeout for the entire operation
      const dumpTimeout = setTimeout(() => {
        if (pgDump && !pgDump.killed) {
          console.error(`[${new Date().toISOString()}] ERROR: Dump operation timeout after 60 minutes for ${config.database}`);
          pgDump.kill();
          clearInterval(progressInterval);
          clearInterval(stallCheckInterval);
          reject(new Error(`Dump operation timeout after 60 minutes for ${config.database}`));
        }
      }, 60 * 60 * 1000); // 60 minutes timeout
      
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ERROR: Exception in performFullDump for ${config.database}: ${error.message}`);
      reject(error);
    }
  });
}

module.exports = { dumpAllTestTables }

// Run the script directly when called directly
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