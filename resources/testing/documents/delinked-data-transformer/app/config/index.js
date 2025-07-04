const Joi = require('joi')

// Define config schema
const schema = Joi.object({
  writeTestDbToDev: Joi.boolean().default(false)
})

// Build config
const writeDb = {
  writeTestDbToDev: process.env.WRITE_TEST_DB_TO_DEV
}

// Validate config
const result = schema.validate(writeDb, {
  abortEarly: false
})

// Throw if config is invalid
if (result.error) {
  throw new Error(`The config is invalid. ${result.error.message}`)
}

module.exports = result.value
