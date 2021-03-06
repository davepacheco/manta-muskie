/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var fs = require('fs');
var net = require('net');
var os = require('os');
var path = require('path');

var apertureConfig = require('aperture-config').config;
var assert = require('assert-plus');
var bsyslog = require('bunyan-syslog');
var bunyan = require('bunyan');
var dashdash = require('dashdash');
var dtrace = require('dtrace-provider');
var libmanta = require('libmanta');
var LRU = require('lru-cache');
var mahi = require('mahi');
var marlin = require('marlin');
var once = require('once');
var restify = require('restify');
var vasync = require('vasync');
var medusa = require('./lib/medusa');
var keyapi = require('keyapi');
var cueball = require('cueball');
var kang = require('kang');

var app = require('./lib');



///--- Globals

var RequestCaptureStream = restify.bunyan.RequestCaptureStream;

var NAME = 'muskie';
var DEFAULT_CFG = __dirname + '/etc/' + NAME + '.config.json';
var LEVEL = process.env.LOG_LEVEL || 'info';
var LOG = bunyan.createLogger({
    name: NAME,
    streams: [ {
        level: LEVEL,
        stream: process.stderr
    } ],
    serializers: restify.bunyan.serializers
});
var AGENT;
var SHARKAGENT;
var MAHI;
var MARLIN;
var KEYAPI;
var OPTIONS = [
    {
        names: ['file', 'f'],
        type: 'string',
        help: 'Configuration file to use.',
        helpArg: 'FILE'
    },
    {
        names: ['insecure-port', 'i'],
        type: 'positiveInteger',
        help: 'Listen for insecure requests on port.',
        helpArg: 'PORT'
    },
    {
        names: ['port', 'p'],
        type: 'positiveInteger',
        help: 'Listen for secure requests on port.',
        helpArg: 'PORT'
    },
    {
        names: ['verbose', 'v'],
        type: 'arrayOfBool',
        help: 'Verbose output. Use multiple times for more verbose.'
    }
];

var PICKER;
var MORAY;
var MEDUSA;
var VERSION = false;



///--- Internal Functions

function configure() {
    var cfg;
    var opts;
    var parser = new dashdash.Parser({options: OPTIONS});

    try {
        opts = parser.parse(process.argv);
        assert.object(opts, 'options');
    } catch (e) {
        LOG.fatal(e, 'invalid options');
        usage(parser, e.message);
    }

    if (!opts.file) {
        usage(parser, '-f option is required');
    }

    cfg = JSON.parse(readFile(opts.file));
    cfg.insecurePort = opts.insecure_port || cfg.insecurePort;
    cfg.port = opts.port || cfg.port;

    cfg.name = 'Manta';
    cfg.version = version();

    if (opts.verbose) {
        opts.verbose.forEach(function () {
            LOG.level(Math.max(bunyan.TRACE, (LOG.level() - 10)));
        });
    }

    if (LOG.level() <= bunyan.DEBUG)
        LOG = LOG.child({src: true});

    LOG.debug(cfg, 'createServer: config loaded');

    // This is ugly, but we set this up so that if muskie is invoked with a
    // -v flag, then we know you're running locally, and you just want the
    // messages to spew to stdout. Otherwise, it's "production", and muskie
    // logs to a syslog endpoint

    function setLogger() {
        cfg.log = LOG;
        cfg.auth.log = LOG;
        cfg.marlin.log = LOG;
        cfg.moray.log = LOG;
        cfg.medusa.log = LOG;
        cfg.cueballHttpAgent.log = LOG;
        cfg.sharkConfig.log = LOG;
    }

    if (opts.verbose || !cfg.bunyan) {
        setLogger();
        return (cfg);
    }

    var cfg_b = cfg.bunyan;

    assert.object(cfg_b, 'config.bunyan');
    assert.optionalString(cfg_b.level, 'config.bunyan.level');
    assert.optionalObject(cfg_b.syslog, 'config.bunyan.syslog');

    var level = cfg_b.level || 'info';
    var streams = [];
    var sysl;

    // We want debug info only IFF the request fails AND the configured
    // log level is info or higher
    if (bunyan.resolveLevel(level) >= bunyan.INFO && cfg_b.syslog) {
        assert.string(cfg_b.syslog.facility,
                      'config.bunyan.syslog.facility');
        assert.string(cfg_b.syslog.type, 'config.bunyan.syslog.type');

        sysl = bsyslog.createBunyanStream({
            facility: bsyslog.facility[cfg_b.syslog.facility],
            name: NAME,
            host: cfg_b.syslog.host,
            port: cfg_b.syslog.port,
            type: cfg_b.syslog.type
        });
        streams.push({
            level: level,
            stream: sysl
        });
        streams.push({
            level: 'debug',
            type: 'raw',
            stream: new RequestCaptureStream({
                level: bunyan.WARN,
                maxRecords: 2000,
                maxRequestIds: 2000,
                streams: [ {
                    raw: true,
                    stream: sysl
                }]
            })
        });
        LOG = bunyan.createLogger({
            name: NAME,
            level: level,
            streams: streams,
            serializers: restify.bunyan.serializers
        });
    }

    setLogger();
    return (cfg);
}

function usage(parser, message)
{
    console.error('muskie: %s', message);
    console.error('usage: node main.js OPTIONS\n');
    console.error(parser.help());
    process.exit(2);
}

function createCueballHttpAgent(cfg) {
    var sharkCfg = cfg.sharkConfig;

    /* Used for connections to mahi and other services. */
    AGENT = new cueball.HttpAgent(cfg.cueballHttpAgent);

    /* Used only for connections to sharks. */
    var sharkCueball = {
        resolvers: sharkCfg.resolvers,
        spares: sharkCfg.spares,
        maximum: sharkCfg.maximum,
        linger: sharkCfg.maxIdleTime,
        tcpKeepAliveInitialDelay: sharkCfg.maxIdleTime,
        log: sharkCfg.log,
        recovery: {
            default: {
                retries: sharkCfg.retry.retries,
                timeout: sharkCfg.connectTimeout,
                maxTimeout: sharkCfg.maxTimeout,
                delay: sharkCfg.maxTimeout
            },
            'dns_srv': {
                retries: 0,
                timeout: sharkCfg.connectTimeout,
                maxTimeout: sharkCfg.maxTimeout,
                delay: 0
            }
        }
    };
    SHARKAGENT = new cueball.HttpAgent(sharkCueball);

    /*
     * Set up the cueball kang monitoring listener. This serves information
     * about all the cueball Pools and Sets in the entire process. This includes
     * those managed by the Agents we create here, but also the Moray client
     * Sets.
     */
    var kangOpts = cueball.poolMonitor.toKangOptions();
    kangOpts.port = cfg.port + 800;
    /*
     * Note that we can't use kang.knStartServer here, as kang's restify
     * version does not match ours and the two will clobber each other.
     */
    var kangServer = restify.createServer({ serverName: 'Kang' });
    kangServer.get(new RegExp('.*'), kang.knRestifyHandler(kangOpts));
    kangServer.listen(kangOpts.port, '0.0.0.0', function () {
        LOG.info('cueball kang monitor started on port %d', kangOpts.port);
    });
}

function createPickerClient(cfg) {
    var opts = {
        connectTimeout: cfg.connectTimeout,
        interval: cfg.interval,
        lag: cfg.lag,
        log: LOG.child({component: 'picker'}, true),
        multiDC: cfg.multiDC,
        url: cfg.url,
        ignoreSize: cfg.ignoreSize
    };

    var client = app.picker.createClient(opts);

    client.once('connect', function onConnect() {
        LOG.info('picker connected %s', client.toString());
        PICKER = client;
    });
}


function createAuthCacheClient(options) {
    assert.object(options, 'options');
    assert.string(options.url, 'options.url');
    assert.optionalObject(options.typeTable, 'options.typeTable');

    var log = LOG.child({component: 'mahi'}, true);
    options.log = log;

    options.typeTable = options.typeTable || apertureConfig.typeTable || {};
    options.agent = AGENT;

    MAHI = mahi.createClient(options);
}

function createKeyAPIClient(opts) {
    var log = opts.log.child({component: 'keyapi'}, true);
    var _opts = {
        log: log,
        ufds: opts.ufds
    };
    KEYAPI = new keyapi(_opts);
}

function createMarlinClient(opts) {
    var log = opts.log.child({component: 'marlin'}, true);
    var _opts = {
        moray: opts,
        setup_jobs: true,
        log: log
    };

    marlin.createClient(_opts, function (err, client) {
        if (err) {
            LOG.fatal(err, 'marlin: unable to create a client');
            process.nextTick(createMarlinClient.bind(null, opts));
        } else {
            var barrier;

            MARLIN = client;
            LOG.info({
                remote: MARLIN.ma_client.host
            }, 'marlin: ready');

            /*
             * In general, for various failures, we should get both an 'error'
             * and a 'close' event.  We want to wait for both so that we don't
             * start reconnecting while the first client is still connected.  (A
             * persistent error could result in way too many Moray connections.)
             */
            barrier = vasync.barrier();
            barrier.start('wait-for-close');
            MARLIN.on('close', function () {
                barrier.done('wait-for-close');
            });

            barrier.start('wait-for-error');
            MARLIN.on('error', function (marlin_err) {
                LOG.error(marlin_err, 'marlin error');
                barrier.done('wait-for-error');
                MARLIN.close();
            });

            barrier.on('drain', function doReconnect() {
                LOG.info('marlin: reconnecting');
                createMarlinClient(opts);
            });
        }
    });
}


function createMorayClient(opts) {
    assert.object(opts, 'options');
    assert.string(opts.host, 'options.host');
    assert.object(opts.log, 'options.log');
    assert.number(opts.port, 'options.port');

    var log = LOG.child({component: 'moray'}, true);
    opts.log = log;

    var client = new libmanta.createMorayClient(opts);

    client.once('error', function (err) {
        client.removeAllListeners('connect');

        log.error(err, 'moray: failed to connect');
    });

    client.once('connect', function onConnect() {
        client.removeAllListeners('error');

        log.info({
            host: opts.host,
            port: opts.port
        }, 'moray: connected');

        MORAY = client;
    });
}


function createMedusaConnector(opts) {
    assert.object(opts, 'options');
    assert.object(opts.log, 'options.log');

    var log = opts.log = opts.log.child({ component: 'medusa' });
    log.debug({ opts: opts }, 'medusa options');

    var client = medusa.createConnector(opts);

    client.once('connect', function onConnect() {
        log.info('medusa: connected');
        MEDUSA = client;
    });
}


function readFile(file) {
    var data;

    try {
        data = fs.readFileSync(file, 'utf8');
    } catch (e) {
        console.error('Unable to load %s: %s', file, e.message);
        process.exit(1);
    }

    return (data);
}


function version() {
    if (!VERSION) {
        var fname = __dirname + '/package.json';
        var pkg = fs.readFileSync(fname, 'utf8');
        VERSION = JSON.parse(pkg).version;
    }

    return (VERSION);
}



///--- Mainline

(function main() {
    var cfg = configure();

    createCueballHttpAgent(cfg);
    createMarlinClient(cfg.marlin);
    createPickerClient(cfg.storage);
    createAuthCacheClient(cfg.auth);
    createMorayClient(cfg.moray);
    createMedusaConnector(cfg.medusa);
    createKeyAPIClient(cfg);

    cfg.jobCache = LRU({
        maxAge: (cfg.marlin.jobCache.expiry * 1000) || 30000,
        max: cfg.marlin.jobCache.size || 1000
    });

    cfg.keyapi = function _keyapi() { return (KEYAPI); };
    cfg.mahi = function mahiClient() { return (MAHI); };
    cfg.marlin = function marlinClient() { return (MARLIN); };
    cfg.picker = function picker() { return (PICKER); };
    cfg.moray = function moray() { return (MORAY); };
    cfg.medusa = function medusaClient() { return (MEDUSA); };
    cfg.sharkAgent = function sharkAgent() { return (SHARKAGENT); };

    cfg.name = 'ssl';

    var dtp = dtrace.createDTraceProvider('muskie');
    var client_close = dtp.addProbe('client_close', 'json');
    var socket_timeout = dtp.addProbe('socket_timeout', 'json');
    client_close.dtp = dtp;
    socket_timeout.dtp = dtp;
    dtp.enable();

    cfg.dtrace_probes = {
        client_close: client_close,
        socket_timeout: socket_timeout
    };

    var server = app.createServer(cfg);
    server.on('error', function (err) {
        LOG.fatal(err, 'server (secure) error');
        process.exit(1);
    });
    server.listen(cfg.port, function () {
        LOG.info('%s listening at (trusted port) %s', NAME, server.url);
    });

    cfg.name = 'insecure';
    var server2 = app.createServer(cfg, true);
    server2.on('error', function (err) {
        LOG.fatal(err, 'server (clear) error');
        process.exit(1);
    });
    server2.listen(cfg.insecurePort, function () {
        LOG.info('%s listening at (clear port) %s', NAME, server2.url);
    });

    app.startKangServer();

    process.on('SIGHUP', process.exit.bind(process, 0));

})();
