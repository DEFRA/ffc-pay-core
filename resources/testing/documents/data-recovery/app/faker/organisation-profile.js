const { Faker, en_GB: enGB, en } = require('@faker-js/faker')
const { seedFakerWithPriority } = require('./faker-seed-entity')

const PROFILE_VERSION = 'organisation-v1'
const faker = new Faker({ locale: [enGB, en] })

function createOrganisationProfile (organisation) {
  seedFakerWithPriority(faker, organisation)
  const houseNumber = faker.number.int({ min: 1, max: 300 })
  const street = faker.location.street()
  const addressFormats = [
    `${houseNumber} ${street}`,
    `${faker.commerce.product()} Cottage, ${street}`,
    `${faker.commerce.productAdjective()} ${faker.commerce.product()} Farm, ${street}`,
    `${faker.commerce.productMaterial()} ${faker.commerce.product()} Company, ${street}`,
    `${faker.commerce.product()} Ltd, ${street}`,
    `Flat ${faker.number.int({ min: 1, max: 20 })}, ${houseNumber} ${street}`
  ]

  return {
    addressLine1: faker.helpers.arrayElement(addressFormats),
    addressLine2: `Near ${faker.location.city()}`,
    addressLine3: faker.location.street(),
    city: faker.location.city(),
    county: faker.location.county(),
    postcode: faker.location.zipCode(),
    emailAddress: faker.internet.email({ provider: 'example.com' }),
    name: faker.company.name()
  }
}

function mapOrganisationFields (organisation, fieldMap, identifiers = organisation) {
  const result = { ...organisation }
  const fields = Object.entries(fieldMap)
  if (fields.length === 0) return result

  const profile = createOrganisationProfile(identifiers)
  for (const [column, profileField] of fields) {
    if (!Object.hasOwn(profile, profileField)) {
      throw new Error(`Unknown organisation profile field: ${profileField}`)
    }
    const value = organisation[column]
    if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) continue
    result[column] = profile[profileField]
  }
  return result
}

module.exports = { PROFILE_VERSION, createOrganisationProfile, mapOrganisationFields }
