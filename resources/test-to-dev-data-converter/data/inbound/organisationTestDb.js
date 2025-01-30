const db = require('../index')

class OrganisationTestDb {
  constructor () {
    this.organisation = db.organisation
  }

  async getData () {
    try {
      const results = await this.organisation.findAll({
        raw: true
      })
      return this.mapColumns(results)
    } catch (error) {
      console.error('Failed to fetch organisation data:', error)
      return []
    }
  }

  mapColumns (data) {
    return data.map(record => ({
      sbi: record.sbi,
      addressLine1: record.addressLine1,
      addressLine2: record.addressLine2,
      addressLine3: record.addressLine3,
      city: record.city,
      county: record.county,
      postcode: record.postcode,
      emailAddress: record.emailAddress,
      frn: record.frn,
      name: record.name,
      updated: record.updated,
      published: record.published
    }))
  }
}

module.exports = new OrganisationTestDb()
