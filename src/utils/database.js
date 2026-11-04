const { Sequelize, DataTypes } = require("sequelize");
const path = require("path");

const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: require("./paths").databasePath,
  logging: false,
});

// Models
const User = sequelize.define("User", {
  userID: { type: DataTypes.STRING, primaryKey: true },
  name: { type: DataTypes.STRING, defaultValue: "Unknown" },
  exp: { type: DataTypes.INTEGER, defaultValue: 0 },
  money: { type: DataTypes.INTEGER, defaultValue: 0 },
  banned: { type: DataTypes.BOOLEAN, defaultValue: false },
  joinedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
});

const Thread = sequelize.define("Thread", {
  threadID: { type: DataTypes.STRING, primaryKey: true },
  name: { type: DataTypes.STRING, defaultValue: "Unknown Thread" },
  prefix: { type: DataTypes.STRING, defaultValue: "/" },
  banned: { type: DataTypes.BOOLEAN, defaultValue: false },
});

const CommandLog = sequelize.define("CommandLog", {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  userID: { type: DataTypes.STRING },
  threadID: { type: DataTypes.STRING },
  command: { type: DataTypes.STRING },
  args: { type: DataTypes.STRING },
  success: { type: DataTypes.BOOLEAN, defaultValue: true },
});

async function initDB() {
  await sequelize.authenticate();
  await sequelize.sync({ alter: true });
  console.log("✅ Database initialized");
}

// Avoid Sequelize's findOrCreate transaction: user and thread lookups are
// launched concurrently and SQLite permits only one writer at a time.
async function findOrCreateRecord(model, key, value, name, fallback) {
  const existing = await model.findByPk(value);
  if (existing) return existing;
  try {
    return await model.create({ [key]: value, name: name || fallback });
  } catch (error) {
    // Another event may have created the same row between the lookup and insert.
    if (error.name !== "SequelizeUniqueConstraintError") throw error;
    return model.findByPk(value);
  }
}
async function getOrCreateUser(userID, name) {
  return findOrCreateRecord(User, "userID", userID, name, "Unknown");
}

async function getOrCreateThread(threadID, name) {
  return findOrCreateRecord(Thread, "threadID", threadID, name, "Unknown Thread");
}

async function logCommand(userID, threadID, command, args, success = true) {
  const argsStr = Array.isArray(args) ? args.join(" ") : (args || "");
  await CommandLog.create({ userID, threadID, command, args: argsStr, success });
}

async function getStats() {
  const totalUsers = await User.count();
  const totalThreads = await Thread.count();
  const totalCommands = await CommandLog.count();
  const recentLogs = await CommandLog.findAll({
    order: [["createdAt", "DESC"]],
    limit: 20,
  });
  return { totalUsers, totalThreads, totalCommands, recentLogs };
}

module.exports = {
  sequelize,
  User,
  Thread,
  CommandLog,
  initDB,
  getOrCreateUser,
  getOrCreateThread,
  logCommand,
  getStats,
};
