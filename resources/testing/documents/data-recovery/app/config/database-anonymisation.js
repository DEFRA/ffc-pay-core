const documentMapper = require('../faker/map-document-org-faker')

const organisations = {
  schema: 'public',
  table: 'organisations',
  identifiers: { frn: 'frn', sbi: 'sbi' },
  fieldMap: documentMapper.FIELD_MAP,
  transform: documentMapper.anonymizeOrganisation
}

module.exports = {
  'ffc-doc-statement-data': [organisations],
  'ffc-doc-statement-constructor': [organisations]
}
