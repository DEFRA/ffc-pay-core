module.exports = (sequelize, DataTypes) => {
  const calculation = sequelize.define('calculation', {
    calculationId: { type: DataTypes.INTEGER, primaryKey: true },
    sbi: DataTypes.INTEGER,
    frn: DataTypes.BIGINT,
    calculationDate: DataTypes.DATE,
    invoiceNumber: DataTypes.STRING,
    scheme: DataTypes.STRING,
    updated: DataTypes.DATE,
    published: DataTypes.DATE
  },
  {
    tableName: 'calculations',
    freezeTableName: true,
    timestamps: false
  })
  calculation.associate = function (models) {
    calculation.hasMany(models.funding, {
      foreignKey: 'calculationId',
      as: 'fundings'
    })
    calculation.belongsTo(models.organisation, {
      foreignKey: 'sbi',
      as: 'organisations'
    })
  }
  return calculation
}
