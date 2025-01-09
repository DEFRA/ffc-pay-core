module.exports = (sequelize, DataTypes) => {
  const paymentReferenceChars = 30
  const paymentPeriodChars = 200
  const d365 = sequelize.define('d365', {
    paymentReference: { type: DataTypes.STRING(paymentReferenceChars), primaryKey: true, allowNull: false },
    calculationId: { type: DataTypes.INTEGER },
    paymentPeriod: { type: DataTypes.STRING(paymentPeriodChars), allowNull: true },
    paymentAmount: { type: DataTypes.DECIMAL, allowNull: false },
    transactionDate: { type: DataTypes.DATE, allowNull: false },
    datePublished: { type: DataTypes.DATE, allowNull: true }
  },
  {
    tableName: 'd365',
    freezeTableName: true,
    timestamps: false
  })
  d365.associate = function (models) {
    d365.belongsTo(models.delinkedCalculation, {
      foreignKey: 'calculationId',
      as: 'delinkedCalculation'
    })
  }
  return d365
}
