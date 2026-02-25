const config = require('../../config')
const dbConfig = config.dbConfig[config.env]

module.exports = (sequelize, DataTypes) => {
  const organisation = sequelize.define('organisation', {
    sbi: { type: DataTypes.INTEGER, primaryKey: true, comment: 'Example Output: 200820241 Source: RPS | Demographics. Used to show customer identifier on statement Used on Statement? Yes Customer details at top of statement' },
    addressLine1: { type: DataTypes.STRING, comment: 'Example Output: 8 The Street Source: RPS | Demographics Used on Statement? Yes Customer details at top of statement. Used to show address, also used for Print & Post' },
    addressLine2: { type: DataTypes.STRING, comment: 'Example Output: Area Source: RPS | Demographics Used on Statement? Yes Customer details at top of statement. Used to show address, also used for Print & Post' },
    addressLine3: { type: DataTypes.STRING, comment: 'Example Output: District Source: RPS | Demographics Used on Statement? Yes Customer details at top of statement. Used to show address, also used for Print & Post' },
    city: { type: DataTypes.STRING, comment: 'Example Output: City Source: RPS | Demographics Used on Statement? Yes Customer details at top of statement. . Used to show address, also used for Print & Post' },
    county: { type: DataTypes.STRING, comment: 'Example Output: County Source: RPS | Demographics Used on Statement? Yes Customer details at top of statement. Used to show address, also used for Print & Post' },
    postcode: { type: DataTypes.STRING, comment: 'Example Output: AA1 1BB Source: RPS | Demographics Used on Statement? Yes Customer details at top of statement. Used to show address, also used for Print & Post' },
    emailAddress: { type: DataTypes.STRING, comment: 'Example Output: my.name@domain.com Source: RPS | Demographics. Used on Statement? No Sent to Notify to email statement to user. Not shown on statement but used for Notify email' },
    frn: { type: DataTypes.BIGINT, comment: 'Example Output: 1106550692 Source: RPS | Demographics. Used on Statement? Yes Filename.  Used to show customer identifier in filename' },
    name: { type: DataTypes.STRING, comment: 'Example Output: The Farm Source: RPS | Demographics. Used on Statement? Yes Customer details at top of statement.  Used to show address, also used for Print & Post' },
    updated: { type: DataTypes.DATE, comment: 'Example Output: 2025-05-13 09:38:02 Source: Documents. Used on Statement? No. Used for ETL Logic. Used to show when data changes' },
    published: { type: DataTypes.DATE, comment: 'Example Output: 2025-05-13 09:38:02 Source: Documents. Used on Statement? No, Used for ETL Logic. Used to determine if a statement has been generated' }
  },
  {
    tableName: 'organisations',
    freezeTableName: true,
    timestamps: false,
    schema: dbConfig.schema
  })
  return organisation
}
