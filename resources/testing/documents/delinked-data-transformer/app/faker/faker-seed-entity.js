/**
 * Utility functions for consistent seeding in faker
 */
const crypto = require('crypto')

function generateSeed (value) {
  const stringValue = String(value)
  const hash = crypto.createHash('md5').update(stringValue).digest('hex')

  return parseInt(hash.substring(0, 8), 16)
}

function seedFakerWithEntity (faker, entity, seedProps) {
  const props = Array.isArray(seedProps) ? seedProps : [seedProps]
  const seedValue = props.map(prop => entity[prop]).join('|')
  const seed = generateSeed(seedValue)
  faker.seed(seed)

  return seed // Return seed for debugging/logging
}

function seedFakerWithPriority (faker, entity, priorityProps, defaultSeed = 'default-seed') {
  for (const prop of priorityProps) {
    if (entity[prop] !== undefined && entity[prop] !== null) {
      const seed = seedFakerWithEntity(faker, entity, prop)
      return { seed, usedProperty: prop }
    }
  }

  console.warn(`No valid seed properties found among [${priorityProps.join(', ')}], using default seed`)
  const seed = generateSeed(defaultSeed)
  faker.seed(seed)

  return { seed, usedProperty: 'default' }
}

module.exports = {
  generateSeed,
  seedFakerWithEntity,
  seedFakerWithPriority
}
