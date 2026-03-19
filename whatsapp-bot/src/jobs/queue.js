const { Queue } = require("bullmq");
const Redis = require("ioredis");

const connection = new Redis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT)
});

const campaignQueue = new Queue("campaignQueue", { connection });

module.exports = { campaignQueue, connection };