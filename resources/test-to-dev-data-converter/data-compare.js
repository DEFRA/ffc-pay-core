const DatabaseConnection = require('./config/database-connection')
const { selectSource } = require('./select-database')
const { passwordPrompt, confirmPrompt, selectComparisonType } = require('./inquirer-prompts')
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
    try {  
        const result = await connection.query(query)
        return result.rows
    } catch (error) {
    throw new Error(`Failed to get table structure: ${error.message}`)
    }
}

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
        throw new Error(`No destination configuration found for: ${sourceKey}`)
    }
    
    console.log(`Destination database will be: ${destConfig.database}`)
    return destConfig
}

async function compareDatabases(sourceConfig, destConfig, comparisonType) {
    let sourceConn, destConn

    try {  
        console.log('\nConnecting to databases...')
        sourceConn = await DatabaseConnection.createConnection(sourceConfig)
        destConn = await DatabaseConnection.createConnection(destConfig)

        console.log('\nPerforming comparison...')
        const [sourceResults, destResults] = await Promise.all([
            comparisonType === 'structure' 
                ? getTableStructure(sourceConn)
                : getTableChecksums(sourceConn),
            comparisonType === 'structure' 
                ? getTableStructure(destConn)
                : getTableChecksums(destConn)
        ])

        const comparison = sourceResults.map(sourceRow => {
            const destRow = destResults.find(r => r.table_name === sourceRow.table_name)
            
            if (!destRow) {
                return {
                    table: sourceRow.table_name,
                    sourceCount: sourceRow.row_count,
                    destCount: 0,
                    inSync: false,
                    differences: 'Table missing in destination'
                }
            }

            const hashType = comparisonType === 'structure' ? 'schema_hash' : 'table_hash'
            const inSync = sourceRow[hashType] === destRow[hashType]

            return {
                table: sourceRow.table_name,
                sourceCount: sourceRow.row_count,
                destCount: destRow.row_count,
                inSync,
                differences: inSync ? null : getDifferenceDescription(comparisonType, sourceRow, destRow)
            }
        })

        return comparison

    } catch (error) {
        throw new Error(`Database comparison failed: ${error.message}`)
    } finally {
        if (sourceConn) await sourceConn.disconnect()
        if (destConn) await destConn.disconnect()
    }
}

function getDifferenceDescription(type, source, dest) {
    if (source.row_count !== dest.row_count) {
        return `Row count mismatch (${source.row_count} vs ${dest.row_count})`
    }
    return type === 'structure' ? 'Schema differences detected' : 'Data differences detected'
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

        const comparisonType = await selectComparisonType()
        console.log(`\nComparison type: ${comparisonType === 'structure' ? 'Structure only' : 'Full comparison'}`)
        
        const confirmed = await confirmPrompt('Do you want to proceed with the database comparison?')
        if (!confirmed) {
            console.log('Operation cancelled by user')
            return
        }

        if (!sourceConfig.password) {
            console.log('Enter source database password:')
            sourceConfig.password = await passwordPrompt()
        }
        if (!destConfig.password) {
            console.log('Enter destination database password:')
            destConfig.password = await passwordPrompt()
        }

        console.log('\nConnecting to databases and performing comparison...')
        const results = await compareDatabases(sourceConfig, destConfig, comparisonType)

        if (results.every(d => d.inSync)) {
            console.log(`\n✅ All tables are in sync (${comparisonType} comparison)`)
        } else {
            console.log(`\n⚠️ Differences detected (${comparisonType} comparison):`)
            console.table(
                results.filter(d => !d.inSync),
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
    getTableChecksums,
    selectDestination
}