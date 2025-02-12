const { Client } = require('pg')
const { selectSource, passwordPrompt, confirmPrompt } = require('./select-database')
const dbMapping = require('./config/db-mapping')

async function getTableChecksums(client) {
    const query = `
        SELECT 
            table_name,
            COUNT(*) as row_count,
            MD5(STRING_AGG(CAST(data AS text), ',' ORDER BY id)) as table_hash
        FROM (
            SELECT *,
                   ROW_TO_JSON(t.*)::text as data
            FROM information_schema.tables 
            CROSS JOIN LATERAL (
                SELECT *
                FROM %I
            ) t
            WHERE table_schema = 'public'
        ) subquery
        GROUP BY table_name;
    `
    
    try {
        const result = await client.query(query)
        return result.rows
    } catch (error) {
        throw new Error(`Failed to get table checksums: ${error.message}`)
    }
}

async function selectDestination(sourceKey) {
    const destConfig = dbMapping.destination[sourceKey]
    if (!destConfig) {
        throw new Error(`No destination configuration found for database: ${sourceKey}`)
    }
    
    console.log(`Destination database will be: ${destConfig.database}`)
    return destConfig
}

async function compareDatabases(sourceConfig, destConfig) {
    const sourceClient = new Client(sourceConfig)
    const destClient = new Client(destConfig)

    try {
        await sourceClient.connect()
        await destClient.connect()

        const sourceResults = await getTableChecksums(sourceClient)
        const destResults = await getTableChecksums(destClient)

        return sourceResults.map(sourceRow => {
            const destRow = destResults.find(r => r.table_name === sourceRow.table_name)
            
            return {
                table: sourceRow.table_name,
                sourceCount: sourceRow.row_count,
                destCount: destRow?.row_count || 0,
                inSync: sourceRow.table_hash === destRow?.table_hash,
                differences: sourceRow.table_hash !== destRow?.table_hash
            }
        })

    } catch (error) {
        throw new Error(`Database comparison failed: ${error.message}`)
    } finally {
        await Promise.all([
            sourceClient.end().catch(console.error),
            destClient.end().catch(console.error)
        ])
    }
}

async function main() {
    try {
        // Get source configuration
        const sourceConfig = await selectSource()
        if (!sourceConfig.connectionName) {
            throw new Error('Invalid source configuration - missing connectionName')
        }

        // Get matching destination configuration
        const destConfig = await selectDestination(sourceConfig.connectionName)
        
        console.log('\nWill compare:')
        console.log(`Source: ${sourceConfig.database}`)
        console.log(`Destination: ${destConfig.database}`)
        
        const confirmed = await confirmPrompt()
        if (!confirmed) {
            console.log('Operation cancelled by user')
            return
        }

        // Handle passwords
        if (!sourceConfig.password) {
            console.log('Enter source database password:')
            sourceConfig.password = await passwordPrompt()
        }
        if (!destConfig.password) {
            console.log('Enter destination database password:')
            destConfig.password = await passwordPrompt()
        }

        console.log('\nComparing databases...')
        const differences = await compareDatabases(sourceConfig, destConfig)

        if (differences.every(d => d.inSync)) {
            console.log('\n✅ All tables are in sync')
        } else {
            console.log('\n⚠️ Differences detected:')
            console.table(
                differences.filter(d => !d.inSync),
                ['table', 'sourceCount', 'destCount', 'differences']
            )
        }

    } catch (error) {
        console.error('Error:', error.message)
        process.exit(1)
    }
}

if (require.main === module) {
    main()
}

module.exports = {
    compareDatabases,
    getTableChecksums,
    selectDestination
}