const { Client } = require('pg')
const { rawlist } = require('@inquirer/prompts')
const { selectSource, passwordPrompt, confirmPrompt } = require('./select-database')
const dbMapping = require('./config/db-mapping')

async function getTableChecksums(client, fromDate) {
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
    
    const result = await client.query(query)
    return result.rows
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

    } finally {
        await sourceClient.end()
        await destClient.end()
    }
}

async function selectDestination(sourceKey, prompter = rawlist) {
    const destChoices = [
        { name: sourceKey, value: sourceKey }
    ]

    const selectedKey = await prompter({
        message: 'Choose destination database:',
        choices: destChoices
    })

    const destConfig = dbMapping.destination[selectedKey]
    if (!destConfig) {
        throw new Error(`No destination configuration found for: ${selectedKey}`)
    }
    console.log(`Selected destination: ${selectedKey}`)
    return destConfig
}

async function main() {
  try {
      const sourceConfig = await selectSource()        
      const destConfig = await selectDestination(sourceConfig.connectionname)
      
      if (!sourceConfig.password) {
          console.log('Enter source database password:')
          sourceConfig.password = await passwordPrompt()
      }
      if (!destConfig.password) {
          console.log('Enter destination database password:')
          destConfig.password = await passwordPrompt()
      }

      console.log('\nComparing all data in databases...')
      const confirmed = await confirmPrompt()
      if (!confirmed) {
          console.log('Operation cancelled by user')
          return
      }

      console.log('\nComparing databases...')
      const differences = await compareDatabases(sourceConfig, destConfig)  // Remove fromDate

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
      console.error('Error comparing databases:', error)
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