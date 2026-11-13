const { mapOrganisationFields } = require('./organisation-profile')

const FIELD_MAP = Object.freeze({
  name: 'name',
  addressLine1: 'addressLine1',
  addressLine2: 'addressLine2',
  addressLine3: 'addressLine3',
  city: 'city',
  county: 'county',
  postcode: 'postcode',
  emailAddress: 'emailAddress'
})

const anonymizeOrganisation = (organisation, identifiers = organisation) => {
  return mapOrganisationFields(organisation, FIELD_MAP, identifiers)
}

module.exports = { FIELD_MAP, anonymizeOrganisation }
