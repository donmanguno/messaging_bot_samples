/**
 *  @author: Mark Manguno
 *  @description: LE Messaging Agent SDK implementation
 */

'use strict';

const Agent = require('node-agent-sdk').Agent;

const winston = require('winston');
const logFormat = winston.format.combine(
    winston.format.label({ label:'bot.js' }),
    winston.format.json(),
    winston.format.timestamp(),
    winston.format.colorize(),
    winston.format.printf(info => { return `${info.timestamp} [${info.label}] ${info.level}: ${info.message}` })
);
const log = winston.createLogger({
    format: logFormat,
    transports: [
        new winston.transports.Console({ timestamp: true, colorize: true, level: process.env.loglevel || 'warn' })
    ]
});

const botConfig = {
    clockPingInterval:  300,    // in seconds
    reconnectAttempts:  35,     // number of reconnect attempts to make
    reconnectInterval:  5,      // first interval in seconds used for reconnect attempts
    reconnectRatio:     1.2     // ratio in the geometric series used to determine reconnect exponential back-off
};

/**
 * Class representing a Bot agent.
 *
 * @extends Agent
 * @property {Function} on
 */
class Bot extends Agent {

    /**
     * Create a Bot
     *
     * @param {Object} config - Config object for agent as defined at https://github.com/LivePersonInc/node-agent-sdk#agent-class
     * @param {String} [initialState=ONLINE] - Bot's initial state. Acceptable values are 'ONLINE', 'OCCUPIED', 'AWAY'
     * @param {Boolean} [subscribeAllConversations=false] - If false, subscribe only to bot's conversations. If true, subscribe to all conversations
     * @param {Boolean} [logfile=false] - If true, log to a file called bot_log.log, log level is 'info' unless otherwise specified in process.env.loglevel
     */
    constructor(config, initialState = 'ONLINE', subscribeAllConversations = false, logfile = false, subscribeToMessagingEvents = true) {
        if (logfile) log.add(new winston.transports.File({ filename: 'bot_log.log', level: process.env.loglevel || 'info' }));

        if (!config) {
            log.warn(`No config provided for account: ${process.env.LP_ACCOUNT}, user: ${process.env.LP_USER}`);
        }

        // Set agent config from environment or file (env takes precedence)
        const _config = {
            accountId: process.env.LP_ACCOUNTID || process.env.LP_ACCOUNT || config && config.accountId,
            username: process.env.LP_USERNAME || process.env.LP_USER || config && config.username,
            password: process.env.LP_PASSWORD || process.env.PASS || config && config.password,
            token: process.env.LP_TOKEN || config && config.token,
            userId: process.env.LP_USERID || config && config.userId,
            assertion: process.env.LP_ASSERTION || config && config.assertion,
            appKey: process.env.LP_APPKEY || config && config.appKey,
            secret: process.env.LP_SECRET || config && config.secret,
            accessToken: process.env.LP_ACCESSTOKEN || config && config.accessToken,
            accessTokenSecret: process.env.LP_ACCESSTOKENSECRET || config && config.accessTokenSecret,
            csdsDomain: process.env.LP_CSDSDOMAIN || config && config.csdsDomain,
            requestTimeout: process.env.LP_REQUESTTIMEOUT || config && config.requestTimeout,
            errorCheckInterval: process.env.LP_ERRORCHECKINTERVAL || config && config.errorCheckInterval,
            apiVersion: process.env.LP_APIVERSION || config && config.apiVersion,
            agent: config && config.agent
        };
        Object.keys(_config).forEach(key => _config[key] === undefined && delete _config[key]);
        super(_config);
        this.config = _config;
        this.initialState = initialState;
        this.subscribeAllConversations = subscribeAllConversations;
        this.subscribeToMessagingEvents = subscribeToMessagingEvents;
        this.init();
    }

    static get const() {
        return {
            CONTENT_NOTIFICATION: 'Bot.Event.Content',
            SC_ACTION_NOTIFICATION: 'Bot.Event.Metadata',
            CONVERSATION_NOTIFICATION: 'Bot.Event.Conversation',
            ROUTING_NOTIFICATION: 'Bot.Event.Routing',
            AGENT_STATE_NOTIFICATION: 'Bot.Event.AgentState',
            CONNECTED: 'Bot.Connected',
            SOCKET_CLOSED: 'Bot.SocketClosed',
            ERROR: 'Bot.Error'
        };
    }

    init() {
        /* In the current version of the Messaging Agent API MessagingEventNotifications are received for all
        conversations, even those to which you have not explicitly subscribed. This automatic subscription is
        error-prone, though, so you must still explicitly subscribe to those conversations you want updates for.
        For this reason it is necessary to keep a list of the conversations whose messagingEventNotifications
        you really want to consume and respond to. Regardless, it is a good practice to maintain such a list
        with important details about each conversation the bot is handling. */
        this.myConversations = {};

        /* Upon establishing a connection to the Messaging service start the periodic keep-alive mechanism,
        subscribe to Agent State notifications, set the bot agent's initial state, subscribe to conversation
        notifications, and subscribe to routing tasks */
        this.on('connected', (message) => {
            clearTimeout(this._retryConnection);
            log.info(`connected: ${JSON.stringify(message)}`);
            this.emit(Bot.const.CONNECTED, message);

            // Get server clock at a regular interval in order to keep the connection alive
            this._pingClock = setInterval(() => {
                getClock(this)
            }, botConfig.clockPingInterval * 1000);

            // Subscribe to Agent State notifications
            this.subscribeAgentsState({}, (e, resp) => {
                if (e) {
                    log.error(`subscribeAgentState: ${JSON.stringify(e)}`)
                }
                else {
                    log.info(`subscribeAgentsState: ${JSON.stringify(resp)}`)
                }
            });

            // Set initial agent state
            this.setBotState(this.initialState);

            // Subscribe to Conversation Notifications
            let convSubParams = {'convState': ['OPEN']};
            if (!this.subscribeAllConversations) convSubParams.agentIds = [this.agentId];
            log.warn(JSON.stringify(convSubParams));
            this.subscribeExConversations(convSubParams, (e, resp) => {
                if (e) {
                    log.error(`subscribeExConversations: ${JSON.stringify(e)}`)
                }
                else {
                    log.info(`subscribeExConversations: ${JSON.stringify(resp)}`)
                }
            });

            // Subscribe to Routing Task notifications
            this.subscribeRoutingTasks({}, (e, resp) => {
                if (e) {
                    log.error(`subscribeRoutingTasks: ${JSON.stringify(e)}`)
                }
                else {
                    log.info(`subscribeRoutingTasks: ${JSON.stringify(resp)}`)
                }
            });

            // Log my agentId
            log.info(`agentId: ${this.agentId}`);
        });

        // Process routing tasks
        // Log them and emit an event
        this.on('routing.RoutingTaskNotification', body => {
            log.info(`routing.RoutingTaskNotification: ${JSON.stringify(body)}`);
            body.changes.forEach((change, index) => {
                log.silly(`routing.RoutingTaskNotification change ${index}: ${JSON.stringify(change)}`);
            });
            this.emit(Bot.const.ROUTING_NOTIFICATION, body);
        });

        // Process agent state notifications
        // Log them, update 'state' attribute, and emit an event
        this.on('routing.AgentStateNotification', body => {
            // logs
            log.info(`routing.AgentStateNotification: ${JSON.stringify(body)}`);
            body.changes.forEach((change, index) => {
                log.silly(`routing.AgentStateNotification change ${index}: ${JSON.stringify(change)}`);
            });

            // set 'state' to the last state received for the MESSAGING channel
            let lastState = body.changes.reverse().find((change) => {
                return change.result && change.result.channels && change.result.channels.find(channel => {
                    return channel === 'MESSAGING'
                })
            });
            this.state = (lastState && lastState.result.availability) || this.state;

            // emit event
            this.emit(Bot.const.AGENT_STATE_NOTIFICATION, body);
        });

        // Process changes in the list of my open conversations
        // Log them and emit an event
        this.on('cqm.ExConversationChangeNotification', body => {
            log.debug(`cqm.ExConversationChangeNotification: ${JSON.stringify(body)}`);
            body.changes.forEach((change, index) => {
                log.silly(`cqm.ExConversationChangeNotification change ${index}: ${(JSON.stringify(change.result.event) || '[no event]')} | ${JSON.stringify(change)}`);

                // When conversations are added or changed the event type will be 'UPSERT'
                if (change.type === 'UPSERT') {

                    // If this is the first time seeing this conversation add it to my list,
                    // get the consumer profile, and subscribe to messaging events
                    if (!this._isInMyConversations(change.result.convId)) {

                        // Add it to myConversations
                        this._addToMyConversations(change.result.convId);
                        log.silly(`${change.result.convId} added to myConversations: ${JSON.stringify(this.myConversations)}`);

                        // Get the consumer profile
                        this.getConsumerProfilePromise(this.getParticipantId(change.result.conversationDetails, 'CONSUMER'))
                            .then(profile => {
                                this.myConversations[change.result.convId].consumerProfile = profile;
                            }).catch(e => {});

                        // Subscribe to messagingEvents
                        if (this.subscribeToMessagingEvents) {
                            this.subscribeMessagingEvents({dialogId: change.result.convId}, (e) => {
                                if (e) {
                                    log.error(`subscribeMessagingEvents: ${JSON.stringify(e)}`)
                                }
                                else {
                                    log.info('subscribeMessagingEvents: success')
                                }
                            });
                        }
                    }

                    // Update this conversation's details in my list
                    this._updateMyConversation(change.result.convId, change.result);

                    // The other type of event is 'DELETE', when conversations are removed from the subscription
                } else if (change.type === 'DELETE') {
                    // Remove the conversation from myConversations
                    delete this.myConversations[change.result.convId];
                    log.silly(`${change.result.convId} removed from myConversations: ${JSON.stringify(this.myConversations)}`);
                }
            });

            this.emit(Bot.const.CONVERSATION_NOTIFICATION, body);
        });

        // Process messaging event notifications
        // Log them, mark the message as read if relevant, and emit an event
        this.on('ms.MessagingEventNotification', body => {

            // log these notifications at debug level
            log.debug(`ms.MessagingEventNotification: ${JSON.stringify(body)}`);

            // Create a list of messages to handle
            const respond = {};
            body.changes.forEach(change => {
                log.silly(`ms.MessagingEventNotification: ${JSON.stringify(change.event)} | ${JSON.stringify(change)}`);

                if (this._isInMyConversations(change.dialogId)) { // This check is necessary because of the subscription bug
                    // add to respond list all content events not by me
                    if (change.event.type === 'ContentEvent' && change.originatorId !== this.agentId) {
                        respond[`${body.dialogId}-${change.sequence}`] = {
                            dialogId: body.dialogId,
                            sequence: change.sequence,
                            message: change.event.message,
                            originatorMetadata: change.originatorMetadata
                        };
                    }
                    // handle AcceptStatusEvents
                    if (change.event.type === 'AcceptStatusEvent') {
                        switch (change.event.status) {
                            // remove from respond list all the messages that were already read by me
                            case 'ACCEPT':
                                if (change.originatorId === this.agentId) {
                                    change.event.sequenceList.forEach(seq => {
                                        delete respond[`${body.dialogId}-${seq}`];
                                    });
                                }
                                break;
                            // emit metadata events
                            case 'ACTION':
                                this.emit(Bot.const.SC_ACTION_NOTIFICATION, {
                                    dialogId: change.dialogId,
                                    sequence: change.sequence,
                                    metadata: change.metadata,
                                    event: change.event,
                                    originatorMetadata: change.originatorMetadata,
                                })
                        }
                    }
                }
            });

            // Mark messages as read only if my role is ASSIGNED_AGENT, and emit a content notification
            if (this.myConversations[body.dialogId]) {
                Object.keys(respond).forEach(key => {
                    let contentEvent = respond[key];
                    if (this.getRole(this.myConversations[body.dialogId].conversationDetails) === 'ASSIGNED_AGENT') {
                        this.markAsRead(contentEvent.dialogId, [contentEvent.sequence]);
                    }
                    this.emit(Bot.const.CONTENT_NOTIFICATION, contentEvent);
                });
            }
        });

        // Handle unidentified notification types
        // TODO: remove after finding all message types
        const handledMessageTypes = [
            'cqm.ExConversationChangeNotification',
            'ms.MessagingEventNotification',
            'routing.RoutingTaskNotification',
            'routing.AgentStateNotification'
        ];
        this.on('notification', msg => {
            if (!handledMessageTypes.includes(msg.type)) {
                log.error(`Got an unhandled message: ${msg.type} ${JSON.stringify(msg)}`);
            }
        });

        // Handle errors
        this.on('error', err => {
            log.error(`generic: ${err} ${JSON.stringify(err)}`);
            this.emit(Bot.const.ERROR, err);
        });

        // Handle socket closed
        this.on('closed', data => {
            clearInterval(this._pingClock);
            log.warn(`socket closed: ${JSON.stringify(data)}`);
            this._reconnect();
        });
    }

    /**
     * Set the bot's state
     *
     * @param {String} newState - Acceptable values are 'ONLINE', 'OCCUPIED', 'AWAY'
     */
    setBotState (newState) {
        this.setAgentState({availability: newState}, (e, resp) => {
            if (e) {
                log.error(`setAgentState: ${JSON.stringify(e)}`)
            }
            else {
                log.info(`setAgentState: ${JSON.stringify(resp)}`)
            }
        });
    }

    /**
     * Get a the consumer's userProfile from a conversation
     *
     * @param {String} consumerId
     */
    getConsumerProfilePromise (consumerId) {
        return new Promise((resolve, reject) => {
            this.getUserProfile(consumerId, (e, resp) => {
                if (e) {
                    log.error(`getConsumerProfilePromise: ${JSON.stringify(e)}`);
                    reject(e);
                } else {
                    log.info(`getConsumerProfilePromise: consumer ${consumerId} consumerProfile ${JSON.stringify(resp)}`);
                    resolve(resp);
                }
            });
        });
    };

    /**
     * Accept ringing conversations
     *
     * @param {Object} data - The entire body of a routingStatusNotification
     * @param {Object[]} data.changes - Individual routing notifications
     * @param {Object[]} data.changes[].result.ringsDetails - Individual rings
     */
    acceptWaitingConversations (data) {
        data.changes.forEach(change => {
            if (change.type === 'UPSERT') {
                change.result.ringsDetails.forEach(ring => {
                    if (ring.ringState === 'WAITING') {
                        this.updateRingState({
                            'ringId': ring.ringId,
                            'ringState': 'ACCEPTED'
                        }, (e, resp) => {
                            if (e) { log.error(`acceptWaitingConversations ${JSON.stringify(e)}`) }
                            else { log.info(`acceptWaitingConversations: Joined conversation ${JSON.stringify(change.result.conversationId)}, ${JSON.stringify(resp)}`) }
                        });
                    }
                });
            }
        });
    };

    /**
     * Join conversation
     *
     * @param {String} conversationId
     * @param {String} role - Possible roles include 'MANAGER', 'ASSIGNED_AGENT', 'READER'
     * @param {Boolean} [announce=false] - Announce presence after joining?
     */
    joinConversation (conversationId, role, announce) {
        if (!/^(READER|MANAGER|ASSIGNED_AGENT)$/.test(role)) {return false}
        this.updateConversationField({
            'conversationId': conversationId,
            'conversationField': [{
                'field': 'ParticipantsChange',
                'type': 'ADD',
                'role': role
            }]
        }, (e, resp) => {
            if (e) { log.error(`joinConversation: ${e.message}`) }
            else {
                log.info(`joinConversation: Joined conversation ${JSON.stringify(conversationId)}, ${JSON.stringify(resp)}`);
                if (announce && role !== 'READER') {
                    this.publishEvent({
                        dialogId: conversationId,
                        event: {
                            type: 'ContentEvent',
                            contentType: 'text/plain',
                            message: role + ' joined'
                        }
                    });
                }
            }
        });
    };

    /**
     * Send text
     *
     * @param {String} conversationId
     * @param {String} message
     * @param {String} [reason] - (Metadata) Reason for this message. Visible in Messaging Interactions API.
     * @param {String|String[]} [topic] - (Metadata) Topic(s) to show in LEUI's Bot Escalation Summary
     */
    sendText (conversationId, message, reason, topic) {
        log.silly(`sending text ${message} to conversation ${conversationId}`);
        let metadata = [{
            type: 'ActionReason',
            reason: reason || 'reason not specified',
            reasonId: '3'
        }];
        if (reason && (topic = reason)) metadata.push({
            type: "BotResponse",
            externalConversationId: conversationId,
            businessCases: typeof topic === 'string' ? [topic] : topic
        });
        this.publishEvent({
            dialogId: conversationId,
            event: {
                type: 'ContentEvent',
                contentType: 'text/plain',
                message: message.toString()
            }
        }, null, metadata, (e, r) => {
            if (e) { log.error(`sendText ${message} ${JSON.stringify(e)}`) }
            else { log.silly(`sendText successful: ${JSON.stringify(r)}`)}
        });
    };

    /**
     * Send rich content (structured content)
     *
     * @param {String} conversationId
     * @param {Object} card - Structured Content Card
     * @param {String} card.id - Card ID for reporting
     * @param {Object} card.content - JSON Object validated at https://livepersoninc.github.io/json-pollock/editor/
     */
    sendRichContent (conversationId, card) {
        log.silly(`sending structured content card ${card.id} to conversation ${conversationId}`);
        this.publishEvent({
            dialogId: conversationId,
            event: {
                type: 'RichContentEvent',
                content: card.content
            }
        }, null, [
            { type: 'ExternalId', id: card.id },
            { type: 'BotResponse', externalConversationId: conversationId, businessCases: ['content'] }
        ], (e, r) => {
            if (e) { log.error(`sendRichContent card ${card.id} ${JSON.stringify(e)} ${JSON.stringify(card.content)}`) }
            else { log.silly(`sendRichContent successful: ${JSON.stringify(r)}`)}
        });
    };

    /**
     *  Mark message(s) as "read"
     *
     * @param {String} conversationId - Conversation whose messages are being marked as read
     * @param {Array.<Number>} sequenceArray - The sequence numbers of the messages to mark as read
     */
    markAsRead (conversationId, sequenceArray) {
        this.publishEvent({
            dialogId: conversationId,
            event: {type: 'AcceptStatusEvent', status: 'READ', sequenceList: sequenceArray}
        }, (e) => {
            if (e) { log.error(`markAsRead ${JSON.stringify(e)}`) }
            else { log.silly('markAsRead successful')}
        });
    };

    /**
     * Transfer conversation to a new skill
     *
     * @param {String} conversationId
     * @param {String} targetSkillId
     */
    transferConversation (conversationId, targetSkillId) {
        log.info(`transferring conversation ${conversationId} to skill ${targetSkillId}`);
        this.updateConversationField({
            conversationId: conversationId,
            conversationField: [
                {
                    field: 'ParticipantsChange',
                    type: 'REMOVE',
                    role: 'ASSIGNED_AGENT'
                },
                {
                    field: 'Skill',
                    type: 'UPDATE',
                    skill: targetSkillId
                }
            ]
        }, null, [
            {
                type: 'ActionReason',
                reason: 'escalated_by_bot', // The reason for escalation, can be other reason
                reasonId: '3'
            },
            {
                type: 'EscalationSummary',   // This is used for the escalation widget in the agent workspace
                escalationCause: 'escalated_by_bot', // The reason for escalation, can be other reason
                businessCases: [                      //all identified capabilities during the conversation
                    {
                        id: 'Help-Greetings',
                        time: 9
                    },
                    {
                        id: 'Payment-Bank_Information',
                        time: 13
                    }
                ],
                conversationDuration: 22,   //conversation duration up to the escalation
                escalatedDuringBusinessCase: 'Payment-Bank_Information' //the capability that led to escalation
            },{
                type: "BotResponse",
                externalConversationId: conversationId,
                businessCases: [
                    "Help-a"
                ]
            }
        ],(e, r) => {
            if (e) { log.error(`transferConversation ${JSON.stringify(e)}`) }
            else { log.silly(`transferConversation successful ${JSON.stringify(r)}`)}
        });
    };

    /**
     * Remove a participant from a conversation
     *
     * @param {String} conversationId
     * @param {String} role
     */
    removeParticipant (conversationId, role) {
        log.info(`leaving conversation ${conversationId}`);
        this.updateConversationField({
            conversationId: conversationId,
            conversationField: [
                {
                    field: 'ParticipantsChange',
                    type: 'REMOVE',
                    role: role
                }
            ]
        }, (e) => {
            if (e) { log.error(`removeParticipant ${JSON.stringify(e)}`) }
            else { log.silly('removeParticipant successful') }
        });
    };

    /**
     * Take over the conversation
     *
     * @param {String} conversationId
     * @param {String} assignedAgent
     */
    takeoverConversation (conversationId, assignedAgent) {
        log.info(`takeoverConversation conversation ${conversationId}`);
        log.silly(`takeoverConversation participants before: ${JSON.stringify(this.myConversations[conversationId].conversationDetails.participants)}`);
        this.updateConversationField({
            conversationId: conversationId,
            conversationField: [
                {
                    field: "ParticipantsChange",
                    type: "REMOVE",
                    role: "ASSIGNED_AGENT",
                    userId: assignedAgent
                },
                {
                    field: "ParticipantsChange",
                    type: "UPDATE",
                    role: "ASSIGNED_AGENT"
                }
            ]
        }, (a, b) => {
            log.warn(a,b);
        })
    }

    /**
     * Close conversation
     *
     * @param {String} dialogId
     * @param {String} [conversationId=dialogId]
     */
    closeConversation (dialogId, conversationId = dialogId) {
        this.updateConversationField({
            'conversationId': conversationId,
            'conversationField': [
                {
                    'field': 'DialogChange',
                    'type': 'UPDATE',
                    'dialog': {
                        'dialogId': dialogId,
                        'state': 'CLOSE'
                    }
                }
            ]
        }, (e, c) => {
            if (e) {
                log.error(`closeConversation: ${e.code} ${e.message}`)
            }
            else { log.info(`closeConversation successful ${c}`) }
        });
    };

    /**
     *  Get assigned agent
     *
     * @param conversationId
     * @returns String - a pid
     */
    getAssignedAgent (conversationId) {
        let participant = this.myConversations[conversationId].conversationDetails.participants.filter(p => p.role === 'ASSIGNED_AGENT')[0];
        return participant && participant.id
    }

    /**
     * Is a specific PID (the bot user by default) a participant in a specific conversation, and if so with what role?
     *
     * @param {Object} conversationDetails - A conversationDetails object from an ExConversationChangeNotification
     * @param {String} [pid=(bot_user_pid)]
     *
     * @returns {String} - A role name or 'undefined'
     */
    getRole (conversationDetails, pid = this.agentId) {
        let participant = conversationDetails.participants.filter(p => p.id === pid)[0];
        return participant && participant.role;
    };

    getParticipantId (conversationDetails, role) {
        let participant = conversationDetails.participants.filter(p => p.role === role)[0];
        return participant && participant.id;
    }

    /**
     * Is this conversation in the "my conversations" list?
     *
     * @param {String} conversationId
     * @returns {Boolean}
     * @private
     */
    _isInMyConversations (conversationId) {
        return !!this.myConversations[conversationId];
    };

    /**
     * Add this conversation to the "my conversations" list
     *
     * @param {String} conversationId
     * @private
     */
    _addToMyConversations (conversationId) {
        this.myConversations[conversationId] = {};
    };

    /**
     * Update this conversation's details in "my conversations" list
     *
     * @param {String} conversationId
     * @param {Object} result - the "result" attribute of an ExConversationChangeNotification
     * @private
     */
    _updateMyConversation (conversationId, result) {
        let _oldData = this.myConversations[conversationId] || {};
        let _newData = {
            convId: result.convId,
            conversationDetails: result.conversationDetails,
            consumerProfile: _oldData.consumerProfile
        };
        if (result.lastContentEventNotification) {
            _newData.lastContentEventNotification = {
                sequence: result.lastContentEventNotification.sequence,
                serverTimestamp: result.lastContentEventNotification.serverTimestamp,
                originatorId: result.lastContentEventNotification.originatorId,
                originatorPId: result.lastContentEventNotification.originatorPId,
                originatorMetadata: { role: result.lastContentEventNotification.originatorMetadata.role },
                event: { type: result.lastContentEventNotification.event.type }
            };
        }
        this.myConversations[conversationId] = _newData;
    };

    /**
     * Attempt to reconnect after the specified delay, then keep trying at an exponentially
     * increasing interval botConfig.reconnectAttempts times.
     *
     * @param {Number} delay
     * @param {Number} attempt
     * @private
     */
    _reconnect (delay = botConfig.reconnectInterval, attempt = 1) {
        clearTimeout(this._retryConnection);
        let bot = this;
        log.warn(`reconnecting in ${Math.round(delay)}s (attempt ${attempt} of ${botConfig.reconnectAttempts})`);
        this._retryConnection = setTimeout(() => {
            bot.reconnect();
            if (++attempt <= botConfig.reconnectAttempts) { bot._reconnect(delay * botConfig.reconnectRatio, attempt) }
            else {log.error`failed to reconnect after ${botConfig.reconnectAttempts} attempts`}
        }, delay * 1000)
    }
}

/**
 * Get the server clock and compare it to the client clock.
 * Also used to periodically ping the server for keep-alive.
 *
 * @param {Object} context
 * @private
 */
const getClock = (context) => {
    let before = new Date();
    context.getClock({}, (e, resp) => {
        if (e) {log.error(`getClock: ${JSON.stringify(e)}`)}
        else {
            let after = new Date();
            log.silly(`getClock: request took ${after.getTime()-before.getTime()}ms, diff = ${resp.currentTime - after}`);
        }
    });
};

// const lelog = (e, r, data) => {
//     if (e) { log.error(`${arguments.caller} card ${card.id} ${JSON.stringify(e)} ${JSON.stringify(card.content)}`) }
//     else { log.silly(`sendRichContent successful: ${JSON.stringify(r)}`)}
// };

module.exports = Bot;
