const faker = require('faker')
const { seedFakerWithPriority } = require('./faker-seed-entity')

faker.locale = 'en_GB'

const anonymizeOrganisation = (organisation) => {
  // Seed faker with priority: FRN first, then SBI as fallback
  const { seed, usedProperty } = seedFakerWithPriority(faker, organisation, ['frn', 'sbi']);

  // Store the seeding info on the result for logging
  const result = {
    sbi: organisation.sbi,
    addressLine1: faker.address.streetAddress(),
    addressLine2: faker.address.secondaryAddress(),
    addressLine3: faker.address.streetName(),
    city: faker.address.city(),
    county: faker.address.county(),
    postcode: faker.address.zipCode(),
    emailAddress: faker.internet.email(),
    frn: organisation.frn,
    name: faker.company.companyName(),
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