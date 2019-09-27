'use strict';

const winston = require('winston');
const logFormat = winston.format.combine(
    winston.format.label({ label:'agent.js' }),
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

// const url = require('url');
// const Agent = require('https-proxy-agent');
// const proxy = new Agent(url.parse('208.84.63.81'));
// Object.assign(agent_config, {agent: proxy});

/**
 * The agent bot starts in the default state ('ONLINE') and subscribes only to its own conversations
 *
 * Bot configuration is set via a config file (see config/example_config.js)
 * and environment variables LP_ACCOUNT and LP_USER
 *
 * transferSkill should be set to the ID of the skill you want the bot to transfer to
 *
 * @type {Bot}
 */

const agent = new Bot(agent_config);
const transferSkill = '277498214';

agent.on(Bot.const.CONNECTED, data => {
    log.info(`CONNECTED ${JSON.stringify(data)}`);
});

agent.on(Bot.const.ROUTING_NOTIFICATION, data => {
    log.info(`ROUTING_NOTIFICATION ${JSON.stringify(data)}`);

    // Accept all waiting conversations
    agent.acceptWaitingConversations(data);
});

agent.on(Bot.const.CONVERSATION_NOTIFICATION, event => {
    log.info(`CONVERSATION_NOTIFICATION ${JSON.stringify(event)}`);
});

agent.on(Bot.const.AGENT_STATE_NOTIFICATION, event => {
    log.info(`AGENT_STATE_NOTIFICATION ${JSON.stringify(event)}`);
});

agent.on(Bot.const.CONTENT_NOTIFICATION, event => {
    log.info(`CONTENT_NOTIFICATION ${JSON.stringify(event)}`);

    // If I am the ASSIGNED_AGENT respond to messages from the CONSUMER
    if (event.originatorMetadata.role === 'CONSUMER'
        && agent.getRole(agent.myConversations[event.dialogId].conversationDetails) === 'ASSIGNED_AGENT') {

        switch (typeof event.message === 'string' ? event.message.toLowerCase() : event.message) {
            case 'transfer':
                agent.sendText(event.dialogId, 'transferring you to a new skill', 'transfer requested');
                agent.transferConversation(event.dialogId, transferSkill);
                break;

            case 'close':
                agent.sendText(event.dialogId, 'ok, bye loser', 'close requested');
                agent.closeConversation(event.dialogId);
                break;

            case 'time':
                agent.sendText(event.dialogId, (new Date()).toTimeString(), 'time requested');
                break;

            case 'date':
                agent.sendText(event.dialogId, (new Date()).toDateString(), 'date requested');
                break;

            case 'online':
                agent.setAgentState({ availability: 'ONLINE' }, () => {});
                break;

            case 'back soon':
                agent.setAgentState({ availability: 'BACK_SOON' }, () => {});
                break;

            case 'away':
                agent.setAgentState({ availability: 'AWAY' }, () => {});
                break;

            case 'offline':
                agent.setAgentState({ availability: 'OFFLINE' }, () => {});
                break;

            case 'content':
                agent.sendRichContent(event.dialogId, {
                    id: Math.floor(Math.random() * 100000).toString(),
                    content: {
                        'type': 'vertical',
                        'elements': [
                            {
                                'type': 'text',
                                'text': 'Product Name',
                                'tooltip': 'text tooltip',
                                'style': {
                                    'bold': true,
                                    'size': 'large'
                                }
                            },
                            {
                                'type': 'text',
                                'text': 'Product description',
                                'tooltip': 'text tooltip'
                            },
                            {
                                'type': 'button',
                                'tooltip': 'button tooltip',
                                'title': 'Add to cart',
                                'click': {
                                    'actions': [
                                        {
                                            'type': 'link',
                                            'name': 'Add to cart',
                                            'uri': 'http://www.google.com'
                                        }
                                    ]
                                }
                            }
                        ]
                    }
                });
                break;

            default:
                agent.sendText(event.dialogId, `you said ${event.message}!`);
                break;
        }
    }
});

agent.on(Bot.const.SOCKET_CLOSED, event => {
    log.info(`SOCKET_CLOSED ${JSON.stringify(event)}`);
});

agent.on(Bot.const.ERROR, error => {
    log.error(`ERROR ${JSON.stringify(error)}`);
});