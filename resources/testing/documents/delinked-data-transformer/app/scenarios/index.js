const { runScenario: runTestToDevScenario } = require('./test-to-dev')
const { runScenario: runPrdToPreScenario } = require('./prd-to-pre')

const scenarioRegistry = {
  'test-to-dev': runTestToDevScenario,
  'prd-to-pre': runPrdToPreScenario
}

async function runScenario (scenarioName, options = {}) {
  const runner = scenarioRegistry[scenarioName] || runTestToDevScenario
  return runner(options)
}

module.exports = {
  scenarioRegistry,
  runScenario
}
