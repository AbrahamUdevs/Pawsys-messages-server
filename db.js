const { Sequelize } = require('sequelize');
const dotenv = require('dotenv');

dotenv.config();

const sequelize = new Sequelize('pawsy', 'root', '', {
  host: 'localhost',
  port: process.env.DBPORT,
  dialect: 'mysql',
  logging: false,
});

module.exports = sequelize;
