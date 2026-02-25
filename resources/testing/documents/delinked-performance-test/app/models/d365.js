const config = require('../../config')
const dbConfig = config.dbConfig[config.env]

module.exports = (sequelize, DataTypes) => {
  const PAYMENT_REFERENCE_LENGTH = 30
  const PAYMENT_PERIOD_LENGTH = 200
  const marketingYearMinYear = 2023
  const marketingYearDefault = 2024
  const marketingYearMaxYear = 2050
  const d365 = sequelize.define('d365', {
    d365Id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: 'Example Output: 1 Source: DWH | D365 Used on Statement? No. Used as a primary key to join data' },
    paymentReference: { type: DataTypes.STRING(PAYMENT_REFERENCE_LENGTH), allowNull: false, comment: 'Example Output: PY1234567 Source: DWH | D365 Used on Statement? Yes. Displayed in the Payment Summary section, and used on remittance and bank statements' },
    marketingYear: { type: DataTypes.INTEGER(), allowNull: false, defaultValue: marketingYearDefault, validate: { isInt: true, min: marketingYearMinYear, max: marketingYearMaxYear, comment: 'Example Output: 2024 Source: DWH | D365 Used on Statement? Yes. Used in the statement heading to show the marketing year of payment' } },
    calculationId: { type: DataTypes.INTEGER, comment: 'Example Output: 987654321 Source: DWH | D365 Used on Statement? No. ID of calculation details and used to join data.' },
    paymentPeriod: { type: DataTypes.STRING(PAYMENT_PERIOD_LENGTH), allowNull: true, comment: 'Example Output: Q4-24 Source: DWH | D365 Used on Statement? No, but could be used for schedules in the future' },
    paymentAmount: { type: DataTypes.DECIMAL, allowNull: false, comment: 'Example Output: 1000.00 Source: DWH | D365 Used on Statement? Yes, used in the Payment Summary to show how much the user has been paid.' },
    transactionDate: { type: DataTypes.DATE, allowNull: false, comment: 'Example Output: 2024-01-31 Source: DWH | D365 Used on Statement? Yes, in the Payment Summary and opening details. This is the date of the payment.' },
    datePublished: { type: DataTypes.DATE, allowNull: true, comment: 'Example Output: 2024-01-31 Source: Documents Used on Statement? No. Used in logic to determine if a statement has been generated' }
  },
  {
    tableName: 'd365',
    freezeTableName: true,
    timestamps: false,
    schema: dbConfig.schema
  })
  d365.associate = function (models) {
    d365.belongsTo(models.delinkedCalculation, {
      foreignKey: 'calculationId',
      as: 'delinkedCalculation'
    })
  }
  return d365
}
