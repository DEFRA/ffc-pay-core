const { dev, test, pre, prd, recovery } = require('../constants/environment-definitions')

module.exports = {
  scenario: 'prd-to-pre',
  sourceEnvironment: 'recovery',
  targetEnvironment: 'test',
  database: {
    port: 5432,
    ssl: true,
    environments: { dev, test, pre, prd, recovery }
  }
}
