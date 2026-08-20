const { faker } = require('@faker-js/faker')
const { seedFakerWithPriority } = require('./faker-seed-entity')
const docsTest = 'DT- '

faker.locale = 'en_GB'

const generateRealisticBritishAddress = () => {
  const houseNumber = faker.number.int({ min: 1, max: 300 })
  const streetName = faker.location.street()
  const addressFormats = [
    `${houseNumber} ${streetName}`,
    `${faker.commerce.product()} Cottage, ${streetName}`,
    `${faker.commerce.productAdjective()} ${faker.commerce.product()} Farm, ${streetName}`,
    `${faker.commerce.productMaterial()} ${faker.commerce.product()} Company, ${streetName}`,
    `${faker.commerce.product()} Ltd, ${streetName}`,
    `Flat ${faker.number.int({ min: 1, max: 20 })}, ${houseNumber} ${streetName}`
  ]

  return faker.helpers.arrayElement(addressFormats)
}

const generateBritishLineTwo = () => {
  const lineTwoFormats = [
    '',
    `Near ${faker.location.city()}`,
    '',
    `Lower ${faker.word.adjective()}`,
    '',
    `${faker.location.cardinalDirection()} ${faker.location.county()}`
  ]

  return faker.helpers.arrayElement(lineTwoFormats)
}

const anonymizeOrganisation = (organisation) => {
  // Seed faker with priority: FRN first, then SBI as fallback
  const { seed, usedProperty } = seedFakerWithPriority(faker, organisation, ['frn', 'sbi'])

  // Store the seeding info on the result for logging
  const result = {
    sbi: organisation.sbi,
    addressLine1: generateRealisticBritishAddress(),
    addressLine2: generateBritishLineTwo(),
    addressLine3: faker.helpers.maybe(() => faker.location.street(), { probability: 0.3 }),
    city: faker.location.city(),
    county: faker.location.county(),
    postcode: `${docsTest}${faker.location.zipCode('??# #??').toUpperCase()}`,
    emailAddress: faker.internet.email(),
    frn: organisation.frn,
    name: faker.company.name(),
    updated: organisation.updated,
    published: organisation.published,
    // Metadata for logging (won't be part of the final SQL)
    _seedInfo: { seed, usedProperty }
  }

  return result
}

const anonymizeOrganisations = (organisations) => {
  return organisations.map(org => anonymizeOrganisation(org))
}

module.exports = {
  anonymizeOrganisation,
  anonymizeOrganisations
}
