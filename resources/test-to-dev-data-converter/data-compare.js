const DatabaseConnection = require('./config/database-connection')
const { selectSource } = require('./select-database')
const { passwordPrompt, confirmPrompt } = require('./inquirer-prompts')
const dbMapping = require('./config/db-mapping')

async function getTableStructure(connection) {
    const query = `
        SELECT 
            table_name,
            COUNT(*) as row_count,
            MD5(STRING_AGG(column_details, ',' ORDER BY ordinal_position)) as schema_hash
        FROM (
            SELECT 
                table_name,
                ordinal_position,
                CONCAT(column_name, ':', data_type, ':', is_nullable) as column_details
            FROM information_schema.columns
            WHERE table_schema = 'public'
        ) cols
        GROUP BY table_name;
    `
    
    const result = await connection.query(query)
    return result.rows
}

async function selectDestination(sourceKey) {
    const destConfig = dbMapping.destination[sourceKey]
    if (!destConfig) {
        throw new Error(`No destination configuration found for: ${sourceKey}`)
    }
    
    console.log(`Destination database will be: ${destConfig.database}`)
    return destConfig
}

async function compareDatabases(sourceConfig, destConfig) {
    let sourceConn, destConn

    try {
        sourceConn = await DatabaseConnection.createConnection(sourceConfig)
        destConn = await DatabaseConnection.createConnection(destConfig)

        const sourceResults = await getTableStructure(sourceConn)
        const destResults = await getTableStructure(destConn)

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
        if (sourceConn) await sourceConn.disconnect()
        if (destConn) await destConn.disconnect()
    }
}

async function main() {
    try {
        const sourceConfig = await selectSource()
        if (!sourceConfig.connectionName) {
            throw new Error('Invalid source configuration - missing connectionName')
        }

        const destConfig = await selectDestination(sourceConfig.connectionName)
        
        console.log('\nWill compare:')
        console.log(`Source: ${sourceConfig.database}`)
        console.log(`Destination: ${destConfig.database}`)
        
        const confirmed = await confirmPrompt('Do you want to proceed with the database comparison?')
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
    getTableStructure,
    selectDestination
}