const config = require('../../config')
const dbConfig = config.dbConfig[config.env]

module.exports = (sequelize, DataTypes) => {
  const FRN_LENGTH = 16

  const delinkedCalculation = sequelize.define('delinkedCalculation', {
    applicationId: { type: DataTypes.INTEGER, allowNull: false, comment: 'Example Output: 1234567 Source: DWH | SitiAgri Used on Statement? No, used in logic to join data' },
    calculationId: { type: DataTypes.INTEGER, primaryKey: true, allowNull: false, comment: 'Example Output: 987654321 Source: DWH | SitiAgri Used on Statement? No, Primary Key and used in logic to join data' },
    sbi: { type: DataTypes.INTEGER, allowNull: false, comment: 'Example Output: 123456789 Source: DWH | SitiAgri Used on Statement? Yes, Opening details of the statement. Customer identifier, standard format on all systems.' },
    frn: { type: DataTypes.STRING(FRN_LENGTH), allowNull: false, comment: 'Example Output: 1234567890 Source: DWH | SitiAgri Used on Statement? Yes, filename. Customer identifier, standard format on all systems' },
    paymentBand1: { type: DataTypes.STRING, allowNull: false, comment: 'Example Output: 30000 Source: DWH | SitiAgri Used on Statement? Yes, Progressive reduction calculation table. Used to show how progressive reductions are calculated.' },
    paymentBand2: { type: DataTypes.STRING, allowNull: false, comment: 'Example Output: 50000 Source: DWH | SitiAgri Used on Statement? Yes, Progressive reduction calculation table. Used to show how progressive reductions are calculated.' },
    paymentBand3: { type: DataTypes.STRING, allowNull: false, comment: 'Example Output: 150000 Source: DWH | SitiAgri Used on Statement? Yes, Progressive reduction calculation table. Used to show how progressive reductions are calculated.' },
    paymentBand4: { type: DataTypes.STRING, allowNull: false, comment: 'Example Output: 9999.99 Source: DWH | SitiAgri Used on Statement? Yes, Progressive reduction calculation table. Used to show how progressive reductions are calculated.' },
    percentageReduction1: { type: DataTypes.STRING, allowNull: false, comment: 'Example Output: 50 Source: DWH | SitiAgri Used on Statement? Yes, Progressive reduction calculation table. Used to show how progressive reductions are calculated.' },
    percentageReduction2: { type: DataTypes.STRING, allowNull: false, comment: 'Example Output: 55 Source: DWH | SitiAgri Used on Statement? Yes, Progressive reduction calculation table. Used to show how progressive reductions are calculated.' },
    percentageReduction3: { type: DataTypes.STRING, allowNull: false, comment: 'Example Output: 65 Source: DWH | SitiAgri Used on Statement? Yes, Progressive reduction calculation table. Used to show how progressive reductions are calculated.' },
    percentageReduction4: { type: DataTypes.STRING, allowNull: false, comment: 'Example Output: 70 Source: DWH | SitiAgri Used on Statement? Yes, Progressive reduction calculation table. Used to show how progressive reductions are calculated.' },
    progressiveReductions1: { type: DataTypes.STRING, allowNull: false, comment: 'Example Output: 15000 Source: DWH | SitiAgri Used on Statement? Yes, Progressive reduction calculation table. Used to show how progressive reductions are calculated.' },
    progressiveReductions2: { type: DataTypes.STRING, allowNull: false, comment: 'Example Output: 11000 Source: DWH | SitiAgri Used on Statement? Yes, Progressive reduction calculation table. Used to show how progressive reductions are calculated.' },
    progressiveReductions3: { type: DataTypes.STRING, allowNull: false, comment: 'Example Output: 65000 Source: DWH | SitiAgri Used on Statement? Yes, Progressive reduction calculation table. Used to show how progressive reductions are calculated.' },
    progressiveReductions4: { type: DataTypes.STRING, allowNull: false, comment: 'Example Output: 35000 Source: DWH | SitiAgri Used on Statement? Yes, Progressive reduction calculation table. Used to show how progressive reductions are calculated.' },
    referenceAmount: { type: DataTypes.STRING, allowNull: false, comment: 'Example Output: 200000 Source: DWH | SitiAgri Used on Statement? Yes, Payment mount calculation table. Used to show how the payment was calculated.' },
    totalProgressiveReduction: { type: DataTypes.STRING, allowNull: false, comment: 'Example Output: 126000 Source: DWH | SitiAgri Used on Statement? Yes, Payment mount calculation table. Used to show how the payment was calculated.' },
    totalDelinkedPayment: { type: DataTypes.STRING, allowNull: false, comment: 'Example Output: 75000 Source: DWH | SitiAgri Used on Statement? Yes, Payment mount calculation table. Used to show how the payment was calculated.' },
    paymentAmountCalculated: { type: DataTypes.STRING, allowNull: false, comment: 'Example Output: 37500 Source: Documents | Calculated Used on Statement? Yes, Payment mount calculation table. Used to show how the payment was calculated.' },
    datePublished: { type: DataTypes.DATE, allowNull: true, comment: 'Example Output: 2025-05-12 15:08:08.776 Source: DWH | SitiAgri Used on Statement? No, used in logic to determine if a statement has been generated' },
    updated: { type: DataTypes.DATE, allowNull: true, comment: 'Example Output: 2025-05-12 15:08:08.776 Source: DWH | SitiAgri Used on Statement? No, used in logic to show when data changes have been made' }
  },
  {
    tableName: 'delinkedCalculation',
    freezeTableName: true,
    timestamps: false,
    schema: dbConfig.schema
  })

  delinkedCalculation.associate = function (models) {
    delinkedCalculation.hasMany(models.d365, {
      foreignKey: 'calculationId',
      as: 'd365Entries'
    })
    delinkedCalculation.belongsTo(models.organisation, {
      foreignKey: 'sbi',
      as: 'organisations'
    })
  }

  return delinkedCalculation
}
