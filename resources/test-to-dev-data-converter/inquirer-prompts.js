const { rawlist, password, confirm } = require('@inquirer/prompts')

async function selectDatabasePrompt(choices, prompter = rawlist) {
    return await prompter({
        message: 'Choose which source to connect to:',
        choices
    })
}

async function selectComparisonType(prompter = rawlist) {
  return await prompter({
      message: 'Choose comparison type:',
      choices: [
          { name: '1: Verify table structure only', value: 'structure' },
          { name: '2: Verify table structure and values', value: 'full' }
      ]
  })
}

async function passwordPrompt(prompter = password) {
    return await prompter({
        message: 'Enter password',
        mask: '*'
    })
}

async function confirmPrompt(message = 'Are you sure you want to continue?', prompter = confirm) {
    return await prompter({
        message
    })
}

module.exports = {
    selectDatabasePrompt,
    selectComparisonType,
    passwordPrompt,
    confirmPrompt,
}