'use strict';

const winston = require('winston');
const logFormat = winston.format.combine(
    winston.format.label({ label:'manager.js' }),
    winston.format.json(),
    winston.format.timestamp(),
    winston.format.colorize(),
    winston.format.printf(info => { return `${info.timestamp} [${info.label}] ${info.level}: ${info.message}` })
);
const log = winston.createLogger({
    format: logFormat,
    transports: [
        new winston.transports.Console({ timestamp: true, colorize: true, level: process.env.loglevel || 'debug' })
    ]
});

const Bot = require('./bot/bot.js');
let agent_config = {};
try {
    agent_config = require('./config/config.js')[process.env.LP_ACCOUNT][process.env.LP_USER];
} catch (ex) {
    log.warn(`Error loading config: ${ex}`)
}

/**
 * The manager bot starts in the Away state and subscribes to all conversations
 *
 * Bot configuration is set via a config file (see config/example_config.js)
 * and environment variables LP_ACCOUNT and LP_USER
 *
 * @type {Bot}
 */

const manager = new Bot(agent_config, 'AWAY', true);

manager.on(Bot.const.CONNECTED, data => {
    log.info(`CONNECTED ${JSON.stringify(data)}`);
});

manager.on(Bot.const.ROUTING_NOTIFICATION, data => {
    log.info(`ROUTING_NOTIFICATION ${JSON.stringify(data)}`);
});

manager.on(Bot.const.CONVERSATION_NOTIFICATION, event => {
    log.info(`CONVERSATION_NOTIFICATION ${JSON.stringify(event)}`);

    // Iterate through notifications
    event.changes.forEach(change => {
        // If I'm not already a participant, join as a manager
        if (!manager.getRole(change.result.conversationDetails)) { manager.joinConversation(change.result.convId, 'MANAGER') }
    });
});

manager.on(Bot.const.AGENT_STATE_NOTIFICATION, event => {
    log.info(`AGENT_STATE_NOTIFICATION ${JSON.stringify(event)}`);
});

manager.on(Bot.const.CONTENT_NOTIFICATION, event => {
    log.info(`CONTENT_NOTIFICATION ${JSON.stringify(event)}`);
});

manager.on(Bot.const.SOCKET_CLOSED, event => {
    log.info(`SOCKET_CLOSED ${JSON.stringify(event)}`);
});

manager.on(Bot.const.ERROR, error => {
    log.error(`ERROR ${JSON.stringify(error)}`);
});