async function runScenario (options = {}) {
  const { dryRun = false, testConnection = false, sourceEnvironment = 'dev', targetEnvironment = 'test' } = options

  console.log('Running scenario: dev-to-test')
  console.log({ sourceEnvironment, targetEnvironment, dryRun, testConnection })

  return {
    scenario: 'dev-to-test',
    sourceEnvironment,
    targetEnvironment,
    dryRun,
    testConnection,
    status: 'not-implemented-in-this-branch'
  }
}

module.exports = {
  runScenario
}
