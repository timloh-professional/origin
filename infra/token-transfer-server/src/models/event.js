'use strict'

module.exports = (sequelize, DataTypes) => {
  const Event = sequelize.define(
    'Event',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      ip: DataTypes.STRING,
      userId: DataTypes.INTEGER,
      grantId: DataTypes.INTEGER,
      action: DataTypes.STRING,
      data: DataTypes.JSONB
    },
    {
      tableName: 't3_event'
    }
  )
  Event.associate = function() {
    // TODO: add a hasOne association for Grant when hasOne supports sourceKey
    // (due in Sequelize 5)
  }
  return Event
}
