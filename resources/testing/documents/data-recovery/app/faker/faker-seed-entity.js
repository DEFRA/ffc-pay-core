const crypto = require('crypto')

const generateSeed = (value) => {
  const hash = crypto.createHash('md5').update(String(value).trim()).digest('hex')
  return parseInt(hash.substring(0, 8), 16)
}

const seedFakerWithPriority = (faker, entity, priorityProps = ['frn', 'sbi']) => {
  for (const property of priorityProps) {
    const value = entity[property]
    if (!['string', 'number', 'bigint'].includes(typeof value) || !String(value).trim()) continue
    const seed = generateSeed(value)
    faker.seed(seed)
    return { seed, usedProperty: property }
  }

  throw new Error(`Cannot anonymise an organisation without a non-empty ${priorityProps.join(' or ')}`)
}

module.exports = { generateSeed, seedFakerWithPriority }
