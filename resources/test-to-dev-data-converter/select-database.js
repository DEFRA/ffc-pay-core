const { rawlist, password, confirm } = require('@inquirer/prompts')
const dbMapping = require('./config/db-mapping')

const sourceChoices = [
    { name: '1: ffc-doc-statement-data-test', value: 'ffc-doc-statement-data' },
    { name: '2: ffc-doc-statement-constructor-test', value: 'ffc-doc-statement-constructor' },
    { name: '3: ffc-doc-statement-generator-test', value: 'ffc-doc-statement-generator' },
    { name: '4: ffc-doc-statement-publisher-test', value: 'ffc-doc-statement-publisher' }
]

async function selectSource(prompter = rawlist) {
    const selectedKey = await prompter({
        message: 'Choose which source to connect to:',
        choices: sourceChoices
    })

    const sourceConfig = dbMapping.source[selectedKey]
    if (!sourceConfig) {
        throw new Error(`No source configuration found for: ${selectedKey}`)
    }
    console.log(`Selected source: ${selectedKey}`)
    return sourceConfig
}

async function passwordPrompt(prompter = password) {
    const enteredPassword = await prompter({
        message: 'Enter password',
        mask: '*'
    })
    return enteredPassword
}

async function confirmPrompt(prompter = confirm) {
    const confirmed = await prompter({
        message: 'Are you sure you want to continue?'
    })
    return confirmed
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
    selectSource, 
    passwordPrompt,
    confirmPrompt
}