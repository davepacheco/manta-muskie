/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var assert = require('assert-plus');
var EventEmitter = require('events').EventEmitter;
var http = require('http');
var moray = require('moray');
var util = require('util');
var Watershed = require('watershed').Watershed;
var utils = require('../utils');


///--- Globals

var clone = utils.shallowCopy;


require('../errors');


///--- API

function MedusaConnector(options) {
    assert.object(options, 'options');
    assert.optionalNumber(options.connectTimeout,
                          'options.connectTimeout');
    assert.optionalNumber(options.inactivityTimeout,
                          'options.inactivityTimeout');
    assert.object(options.log, 'options.log');
    assert.object(options.moray, 'options.moray'); // electric moray
    assert.string(options.moray.host, 'options.moray.host');
    assert.number(options.moray.port, 'options.moray.port');
    assert.object(options.reflector, 'options.reflector');
    assert.string(options.reflector.host, 'options.reflector.host');
    assert.number(options.reflector.port, 'options.reflector.port');

    EventEmitter.call(this);
    var self = this;

    self.log = options.log;
    self.url = options.url;

    self.connectTimeout = options.connectTimeout || 1000;
    self.inactivityTimeout = options.inactivityTimeout || 30000;
    self.watershed = new Watershed();
    self.moray = moray.createClient({
        unwrapErrors: true,
        log: options.log,
        connectTimeout: self.connectTimeout,
        host: options.moray.host,
        port: options.moray.port
    });

    // For new Medusa sessions, we establish a connection to the
    // Medusa binder name.  Subsequent participants will find
    // the particular reflector we started the session on in our
    // Moray bucket.
    self.defaultMedusa = {
        medusa_ip: options.reflector.host,
        medusa_port: options.reflector.port
    };
    self.log.debug({ medusa: self.defaultMedusa }, 'default medusa');

    self.moray.on('close', function medMorayClose() {
        self.log.debug('medusa: moray closed');
    });

    self.moray.on('connect', function medMorayConnect() {
        self.log.debug('medusa: moray connected');
        self.emit('connect');
    });

    self.moray.on('error', function medMorayError(err) {
        self.log.error(err, 'medusa: moray error');
        self.emit('error', err);
    });
}
util.inherits(MedusaConnector, EventEmitter);


MedusaConnector.prototype.toString = function toString() {
    var str = '[object MedusaConnector <';
    str += '>]';

    return (str);
};


MedusaConnector.prototype.findMedusaBackend = function
findMedusaBackend(requestId, jobId, orDefaults, callback) {
    assert.ok(requestId);
    assert.string(jobId, 'jobId');
    assert.bool(orDefaults, 'orDefaults');
    assert.func(callback, 'callback');

    var self = this;
    var log = self.log.child({
        method: 'findMedusaBackend',
        requestId: requestId,
        jobId: jobId,
        orDefaults: orDefaults
    }, true);

    self.moray.getObject('medusa_sessions', jobId, function (err, obj) {
        var out;

        if (err && err.name !== 'ObjectNotFoundError') {
            log.debug({ err: err }, 'unexpected error');
            callback(err);
            return;
        }

        if (err) {
            // If we don't find a session in the directory for
            // this master connection, and we've been asked to
            // return the defaults, then do so.  New master-side
            // connections use this to establish a virgin
            // session.
            if (!orDefaults) {
                err = new ResourceNotFoundError('Session' +
                                                ' for job ' + jobId);
                log.debug({ err: err }, 'session not found');
                callback(err);
                return;
            }

            out = clone(self.defaultMedusa);
            log.debug({ medusa: out }, 'session not found; ' +
                      'returning default');
        } else {
            // We have found a Medusa Reflector for this job ID.
            out = obj.value;
            log.debug({ medusa: out }, 'session found');
        }
        callback(null, out);
    });
};


MedusaConnector.prototype.createBackendConnection = function
createBackendConnection(requestId, jobId, type, medusa, callback) {
    assert.ok(requestId);
    assert.string(jobId);
    assert.string(type);
    assert.object(medusa);
    assert.string(medusa.medusa_ip);
    assert.number(medusa.medusa_port);

    var self = this;
    var log = self.log.child({
        method: 'createBackendConnection',
        requestId: requestId,
        jobId: jobId,
        type: type,
        medusa: medusa
    }, true);

    var wskey = self.watershed.generateKey();
    var outopts = {
        port: medusa.medusa_port,
        hostname: medusa.medusa_ip,
        headers: {
            'connection': 'upgrade',
            'upgrade': 'websocket',
            'sec-websocket-key': wskey
        },
        path: '/attach/' + jobId + '/' + type,
        method: 'GET'
    };

    log.debug({ backendOptions: outopts }, 'connecting to medusa ' +
              'reflector');

    var done = false;
    var outreq = http.request(outopts);
    outreq.on('error', function mbeOnError(err) {
        if (done)
            return;
        done = true;

        log.error({ err: err }, 'could not connect to reflector');
        callback(new InternalError(err));
        return;
    });
    outreq.on('response', function mbeOnResponse(outres) {
        if (done)
            return;
        done = true;

        log.error({ res: outres }, 'backend medusa did not upgrade' +
                  ' to websockets');
        callback(new Error('Medusa Backend Error ' +
                           outres.statusCode));
        return;
    });
    outreq.on('upgrade', function mbeOnUpgrade(outres, socket, head) {
        if (done)
            return;
        done = true;

        log.debug({ res: outres }, 'backend medusa upgrading to ' +
                  'web sockets');

        // Use Watershed for the initial websockets handshake, but
        // request a detached socket/head pair.  We don't need to
        // parse or process web sockets frames in muskie -- we
        // leave that to medusa, treating the socket as straight TCP
        // from now on.
        var upsock;
        try {
            upsock = self.watershed.connect(outres, socket, head,
                                            wskey, true);
        } catch (ex) {
            log.error({ err: ex }, 'unexpected error upgrading' +
                      ' to websockets');
            callback(new Error('Medusa Backend Error'));
            return;
        }

        log.debug('backend medusa connection upgraded to web ' +
                  'sockets');
        callback(null, upsock);
    });
    outreq.end();
};


///--- Exports

module.exports = {

    createConnector: function createConnector(options) {
        return (new MedusaConnector(options));
    }

};

/// vim: set ts=8 sts=8 sw=8 et:
