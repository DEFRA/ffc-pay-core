module.exports = (sequelize, DataTypes) => {
  const number2 = 2
  const number15 = 15
  const number20 = 20
  const number50 = 50
  const total = sequelize.define('total', {
    calculationId: { type: DataTypes.INTEGER, primaryKey: true, allowNull: false },
    sbi: { type: DataTypes.INTEGER, allowNull: false },
    frn: { type: DataTypes.BIGINT, allowNull: false },
    agreementNumber: { type: DataTypes.INTEGER, allowNull: false },
    claimId: { type: DataTypes.INTEGER, allowNull: false },
    schemeType: { type: DataTypes.STRING(number50), allowNull: false },
    calculationDate: { type: DataTypes.DATE, allowNull: false },
    invoiceNumber: { type: DataTypes.STRING(number20), allowNull: false },
    agreementStart: { type: DataTypes.DATE, allowNull: false },
    agreementEnd: { type: DataTypes.DATE, allowNull: false },
    totalAdditionalPayments: { type: DataTypes.DECIMAL(number15, number2), allowNull: false },
    totalActionPayments: { type: DataTypes.DECIMAL(number15, number2), allowNull: false },
    totalPayments: { type: DataTypes.DECIMAL(number15, number2), allowNull: false },
    updated: { type: DataTypes.DATE },
    datePublished: { type: DataTypes.DATE, allowNull: true }
  },
  {
    tableName: 'totals',
    freezeTableName: true,
    timestamps: false
  })
  total.associate = function (models) {
    total.hasMany(models.dax, {
      foreignKey: 'calculationId',
      as: 'daxEntries'
    })
    total.hasMany(models.action, {
      foreignKey: 'calculationId',
      as: 'actions'
    })
    total.belongsTo(models.organisation, {
      foreignKey: 'sbi',
      as: 'organisations'
    })
  }
  return total
}
