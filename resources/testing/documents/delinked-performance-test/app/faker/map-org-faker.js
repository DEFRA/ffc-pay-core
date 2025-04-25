const faker = require('faker')
faker.locale = 'en_GB'

const anonymizeOrganisation = (organisation) => {
  return {
    sbi: organisation.sbi,
    addressLine1: faker.address.streetAddress(),
    addressLine2: faker.address.secondaryAddress(),
    addressLine3: faker.address.streetName(),
    city: faker.address.city(),
    county: faker.address.county(),
    postcode: faker.address.zipCode(),
    emailAddress: faker.internet.email(),
    frn: organisation.frn(),
    name: faker.company.companyName(),
    updated: organisation.updated,
    published: organisation.published
  }
}

const anonymizeOrganisations = (organisations) => {
  return organisations.map(org => anonymizeOrganisation(org))
}

module.exports = {
  anonymizeOrganisation,
  anonymizeOrganisations
}
