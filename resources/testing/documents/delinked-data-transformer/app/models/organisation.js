module.exports = (sequelize, DataTypes) => {
  const organisation = sequelize.define('organisation', {
    sbi: { type: DataTypes.INTEGER, primaryKey: true },
    addressLine1: DataTypes.STRING,
    addressLine2: DataTypes.STRING,
    addressLine3: DataTypes.STRING,
    city: DataTypes.STRING,
    county: DataTypes.STRING,
    postcode: DataTypes.STRING,
    emailAddress: DataTypes.STRING,
    frn: DataTypes.BIGINT,
    name: DataTypes.STRING,
    updated: DataTypes.DATE,
    published: DataTypes.DATE
  },
  {
    tableName: 'organisations',
    freezeTableName: true,
    timestamps: false
  })
  organisation.associate = function (models) {
    organisation.hasMany(models.calculation, {
      foreignKey: 'sbi',
      as: 'calculations'
    })
  }
  return organisation
}
