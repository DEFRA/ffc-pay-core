const { mapOrganisationFields } = require('./organisation-profile')

const FIELD_MAP = Object.freeze({})

function anonymizeOrganisation (organisation, identifiers = organisation) {
  return mapOrganisationFields(organisation, FIELD_MAP, identifiers)
}

module.exports = { FIELD_MAP, anonymizeOrganisation }
