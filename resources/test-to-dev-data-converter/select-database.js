const { selectDatabasePrompt } = require('./inquirer-prompts')
const dbMapping = require('./config/db-mapping')

function getSourceChoices() {
    return Object.keys(dbMapping.source).map((dbName, index) => ({
        name: `${index + 1}: ${dbName}`,
        value: dbName
    }))
}

async function selectSource() {
    const selectedKey = await selectDatabasePrompt(getSourceChoices())
    const sourceConfig = dbMapping.source[selectedKey]
    
    if (!sourceConfig) {
        throw new Error(`No source configuration found for: ${selectedKey}`)
    }
    
    console.log(`Selected source: ${selectedKey}`)
    return sourceConfig
}

if (require.main === module) {
    selectSource()
        .then(source => {
            console.log('Test complete. Updated source configuration:', source)
        })
        .catch(err => {
            console.error('Error running test:', err)
        })
}

module.exports = { 
    getSourceChoices,
    selectSource 
}