/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

var Guacamole = Guacamole || {};

/**
 * Bootstraps the worker-side half of {@link Guacamole.WorkerClient}. When
 * loaded in a Web Worker context, this module listens for an init message
 * from the main thread, at which point it constructs a Tunnel, Parser,
 * Client, and Display all operating entirely within the worker. Compositor
 * operations are serialized back to the main thread via a
 * {@link Guacamole.Display.WorkerStage}, and Client-level events (state
 * changes, streams, etc.) are forwarded via postMessage for handling by the
 * main-thread facade.
 *
 * Loading this module in a non-worker context is a no-op.
 *
 * @namespace
 */
Guacamole.WorkerBootstrap = {};

/**
 * Returns true if the current execution context is a dedicated Web Worker
 * as created by {@code new Worker(url)}. Used to conditionally install the
 * worker-side bootstrap when the concatenated library is loaded both in
 * main-thread and worker contexts.
 *
 * @returns {!boolean}
 */
Guacamole.WorkerBootstrap.isWorkerContext = function isWorkerContext() {
    return typeof self !== 'undefined'
        && typeof importScripts === 'function'
        && typeof document === 'undefined'
        && typeof window === 'undefined';
};

/**
 * Installs the worker bootstrap on the given message port, which is typically
 * the worker's global {@code self}. This sets up a message listener and runs
 * until an init message arrives, at which point the worker is brought up and
 * begins handling incoming instructions and outgoing events.
 *
 * @param {!(DedicatedWorkerGlobalScope|MessagePort)} port
 *     The object to which the worker will post messages and from which it
 *     will receive them.
 */
Guacamole.WorkerBootstrap.install = function install(port) {

    var state = {
        stage: null,
        display: null,
        client: null,
        tunnel: null
    };

    /**
     * Worker-side map of every {@link Guacamole.InputStream} currently
     * proxied to the main thread, keyed by stream index. Entries are added
     * as incoming stream announcements arrive and removed when the stream
     * ends.
     *
     * @private
     * @type {!Object.<number, !Guacamole.InputStream>}
     */
    var proxiedInputStreams = {};

    /**
     * Worker-side map of every outbound {@link Guacamole.OutputStream}
     * created on behalf of the main thread, keyed by the facadeId assigned
     * by the main-thread {@code Guacamole.WorkerClient}.
     *
     * @private
     * @type {!Object.<number, !Guacamole.OutputStream>}
     */
    var proxiedOutputStreams = {};

    /**
     * Installs forwarding handlers on the given input stream so that blob
     * and end events are delivered to the main thread. Also tracks the
     * stream in {@link proxiedInputStreams} so that incoming sendAck
     * messages can be routed correctly.
     *
     * @private
     * @param {!Guacamole.InputStream} stream
     */
    function proxyInputStream(stream) {

        proxiedInputStreams[stream.index] = stream;

        stream.onblob = function streamBlob(data) {
            port.postMessage({
                type: 'stream.blob',
                streamIndex: stream.index,
                data: data
            });
        };

        stream.onend = function streamEnd() {
            delete proxiedInputStreams[stream.index];
            port.postMessage({
                type: 'stream.end',
                streamIndex: stream.index
            });
        };

    }

    /**
     * Creates a new outbound output stream of the type described by the
     * given message, installs an ack forwarder on it, and tracks it in
     * {@link proxiedOutputStreams} so that subsequent blob/end messages
     * from the main thread can be routed correctly.
     *
     * @private
     * @param {!Object} message
     *     The createStream message, containing a facadeId assigned by the
     *     main thread and the parameters that would ordinarily be passed
     *     to the corresponding {@link Guacamole.Client} factory method.
     */
    function proxyCreateOutputStream(message) {

        if (!state.client)
            return;

        var stream;
        switch (message.streamType) {

            case 'audio':
                stream = state.client.createAudioStream(message.mimetype);
                break;

            case 'clipboard':
                stream = state.client.createClipboardStream(message.mimetype);
                break;

            case 'file':
                stream = state.client.createFileStream(message.mimetype, message.filename);
                break;

            case 'pipe':
                stream = state.client.createPipeStream(message.mimetype, message.name);
                break;

            case 'argv':
                stream = state.client.createArgumentValueStream(message.mimetype, message.name);
                break;

            case 'output':
                stream = state.client.createOutputStream();
                break;

            default:
                port.postMessage({
                    type: 'stream.ack',
                    facadeId: message.facadeId,
                    status: { code: 0x0301, message: 'Unknown stream type' }
                });
                return;

        }

        proxiedOutputStreams[message.facadeId] = stream;

        stream.onack = function streamAck(status) {
            port.postMessage({
                type: 'stream.ack',
                facadeId: message.facadeId,
                streamIndex: stream.index,
                status: {
                    code: status.code,
                    message: status.message
                }
            });
            // The stream is invalidated by the server on error codes; the
            // main-thread facade is expected to stop using it after such an
            // ack. No local cleanup is required here because Client.js
            // already removes the stream from its own output_streams map
            // when an error ack is received.
            if (status.code >= 0x0100)
                delete proxiedOutputStreams[message.facadeId];
        };

        port.postMessage({
            type: 'stream.created',
            facadeId: message.facadeId,
            streamIndex: stream.index
        });

    }

    /**
     * Constructs a Guacamole.Tunnel from the given descriptor. Only
     * descriptors describing absolute URLs are supported; the main-thread
     * facade is expected to resolve any relative URLs before sending.
     *
     * @private
     * @param {!Object} descriptor
     *     The tunnel descriptor. Must contain a "type" field and any
     *     type-specific parameters.
     *
     * @returns {!Guacamole.Tunnel}
     *     A newly-constructed Tunnel corresponding to the descriptor.
     *
     * @throws {!Error}
     *     If the descriptor's type is not recognized.
     */
    function createTunnel(descriptor) {

        switch (descriptor.type) {

            case 'websocket':
                return new Guacamole.WebSocketTunnel(descriptor.url);

            case 'http':
                return new Guacamole.HTTPTunnel(
                        descriptor.url,
                        descriptor.crossDomain,
                        descriptor.extraTunnelHeaders);

            case 'static-http':
                return new Guacamole.StaticHTTPTunnel(
                        descriptor.url,
                        descriptor.crossDomain,
                        descriptor.extraTunnelHeaders);

            default:
                throw new Error('Unknown tunnel type: ' + descriptor.type);

        }

    }

    /**
     * Wires the given Client's notification callbacks to postMessage-based
     * forwarding so that the main-thread facade can re-raise them. Stream-
     * bearing callbacks currently only report that a stream has appeared;
     * full stream proxying is handled separately.
     *
     * @private
     * @param {!Guacamole.Client} client
     */
    function wireClientEvents(client) {

        client.onstatechange = function onstatechange(newState) {
            port.postMessage({ type: 'client.statechange', state: newState });
        };

        client.onerror = function onerror(status) {
            port.postMessage({
                type: 'client.error',
                status: {
                    code: status.code,
                    message: status.message
                }
            });
        };

        client.onname = function onname(name) {
            port.postMessage({ type: 'client.name', name: name });
        };

        client.onsync = function onsync(timestamp, frames) {
            port.postMessage({
                type: 'client.sync',
                timestamp: timestamp,
                frames: frames
            });
        };

        client.onrequired = function onrequired(parameters) {
            port.postMessage({
                type: 'client.required',
                parameters: parameters
            });
        };

        // Multi-user lifecycle events
        client.onjoin = function onjoin(id, name) {
            port.postMessage({ type: 'client.join', id: id, name: name });
        };

        client.onleave = function onleave(id) {
            port.postMessage({ type: 'client.leave', id: id });
        };

        // Inbound stream-bearing callbacks. Each stream is proxied: the
        // announcement is forwarded to the main thread together with the
        // stream index, and forwarding handlers are installed on the
        // worker-side stream so that blob/end events are mirrored across
        // the boundary.

        client.onaudio = function onaudio(stream, mimetype) {
            proxyInputStream(stream);
            port.postMessage({
                type: 'client.audio',
                streamIndex: stream.index,
                mimetype: mimetype
            });
        };

        client.onclipboard = function onclipboard(stream, mimetype) {
            proxyInputStream(stream);
            port.postMessage({
                type: 'client.clipboard',
                streamIndex: stream.index,
                mimetype: mimetype
            });
        };

        client.onfile = function onfile(stream, mimetype, filename) {
            proxyInputStream(stream);
            port.postMessage({
                type: 'client.file',
                streamIndex: stream.index,
                mimetype: mimetype,
                filename: filename
            });
        };

        client.onpipe = function onpipe(stream, mimetype, name) {
            proxyInputStream(stream);
            port.postMessage({
                type: 'client.pipe',
                streamIndex: stream.index,
                mimetype: mimetype,
                name: name
            });
        };

        client.onargv = function onargv(stream, mimetype, name) {
            proxyInputStream(stream);
            port.postMessage({
                type: 'client.argv',
                streamIndex: stream.index,
                mimetype: mimetype,
                name: name
            });
        };

        // Filesystem objects and video streams currently surface metadata
        // only. Proxying Guacamole.Object (which itself contains multiple
        // sub-streams) and rebuilding a worker-side Layer reference on the
        // main thread are follow-up items.

        client.onfilesystem = function onfilesystem(object, name) {
            port.postMessage({
                type: 'client.filesystem',
                objectIndex: object.index,
                name: name
            });
        };

        client.onvideo = function onvideo(stream, layer, mimetype) {
            port.postMessage({
                type: 'client.video',
                streamIndex: stream.index,
                layerContainerId: layer && typeof layer.__getContainer === 'function'
                        ? layer.__getContainer().__id
                        : null,
                mimetype: mimetype
            });
        };

        client.onmultitouch = function onmultitouch(layer, touches) {
            port.postMessage({
                type: 'client.multitouch',
                layerContainerId: layer && typeof layer.__getContainer === 'function'
                        ? layer.__getContainer().__id
                        : null,
                touches: touches
            });
        };

    }

    /**
     * Wires the given Tunnel's notification callbacks to postMessage-based
     * forwarding so that the main-thread facade can re-raise them.
     *
     * @private
     * @param {!Guacamole.Tunnel} tunnel
     */
    function wireTunnelEvents(tunnel) {

        tunnel.onerror = function onerror(status) {
            port.postMessage({
                type: 'tunnel.error',
                status: {
                    code: status.code,
                    message: status.message
                }
            });
        };

        tunnel.onuuid = function onuuid(uuid) {
            port.postMessage({ type: 'tunnel.uuid', uuid: uuid });
        };

        tunnel.onstatechange = function onstatechange(state) {
            port.postMessage({ type: 'tunnel.statechange', state: state });
        };

    }

    /**
     * Wires the given Display's statistics callback to postMessage-based
     * forwarding so the main-thread facade can re-raise it.
     *
     * @private
     * @param {!Guacamole.Display} display
     */
    function wireDisplayEvents(display) {

        display.onresize = function onresize(width, height) {
            port.postMessage({
                type: 'display.resize',
                width: width,
                height: height
            });
        };

        display.oncursor = function oncursor(canvas, hotspotX, hotspotY) {

            // Produce an ImageBitmap that the main thread can consume.
            // Using createImageBitmap avoids the OffscreenCanvas-reset
            // semantics of transferToImageBitmap.
            if (typeof createImageBitmap !== 'function') {
                port.postMessage({
                    type: 'display.cursor',
                    x: hotspotX,
                    y: hotspotY
                });
                return;
            }

            createImageBitmap(canvas).then(function bitmapReady(bitmap) {
                port.postMessage({
                    type: 'display.cursor',
                    bitmap: bitmap,
                    x: hotspotX,
                    y: hotspotY
                }, [bitmap]);
            }, function captureFailed() {
                port.postMessage({
                    type: 'display.cursor',
                    x: hotspotX,
                    y: hotspotY
                });
            });

        };

        display.onstatistics = function onstatistics(stats) {
            port.postMessage({
                type: 'display.statistics',
                stats: stats
            });
        };

    }

    /**
     * Handles an incoming 'init' message, constructing the worker-side
     * Tunnel/Client/Display and wiring all event callbacks back to the
     * main thread.
     *
     * @private
     * @param {!Object} message
     */
    function handleInit(message) {

        if (state.client) {
            port.postMessage({
                type: 'error',
                message: 'Worker already initialized'
            });
            return;
        }

        try {

            state.tunnel = createTunnel(message.tunnel);
            state.stage = new Guacamole.Display.WorkerStage(port);
            state.display = new Guacamole.Display(state.stage);
            state.client = new Guacamole.Client(state.tunnel, state.display);

            wireDisplayEvents(state.display);
            wireClientEvents(state.client);
            wireTunnelEvents(state.tunnel);

            port.postMessage({ type: 'ready' });

        }
        catch (e) {
            port.postMessage({
                type: 'error',
                message: e && e.message ? e.message : String(e)
            });
        }

    }

    /**
     * Handles messages arriving from the main thread.
     *
     * @private
     * @param {!MessageEvent} event
     */
    function handleMessage(event) {

        var message = event.data;
        if (!message || typeof message.type !== 'string')
            return;

        switch (message.type) {

            case 'init':
                handleInit(message);
                break;

            case 'connect':
                if (state.client)
                    state.client.connect(message.data);
                break;

            case 'disconnect':
                if (state.client)
                    state.client.disconnect();
                break;

            case 'sendKeyEvent':
                if (state.client)
                    state.client.sendKeyEvent(message.pressed, message.keysym);
                break;

            case 'sendMouseState':
                if (state.client)
                    state.client.sendMouseState(message.state, false);
                break;

            case 'sendTouchState':
                if (state.client)
                    state.client.sendTouchState(message.state, false);
                break;

            case 'sendSize':
                if (state.client)
                    state.client.sendSize(message.width, message.height);
                break;

            case 'setScale':
                // Scale is a main-thread concern, but the instruction is
                // harmless here; no-op.
                break;

            case 'display.showCursor':
                if (state.display)
                    state.display.showCursor(message.shown);
                break;

            //
            // Stream proxy
            //

            case 'sendAck':
                // Forward an acknowledgement from the main-thread facade
                // through to the server via the Client. The main-thread
                // facade's InputStream does not exist on this side; we
                // call Client.sendAck directly with the known stream
                // index.
                if (state.client)
                    state.client.sendAck(message.streamIndex, message.message, message.code);
                break;

            case 'createStream':
                proxyCreateOutputStream(message);
                break;

            case 'sendBlob': {
                var outStream = proxiedOutputStreams[message.facadeId];
                if (outStream)
                    outStream.sendBlob(message.data);
                break;
            }

            case 'sendEnd': {
                var outStream = proxiedOutputStreams[message.facadeId];
                if (outStream) {
                    outStream.sendEnd();
                    delete proxiedOutputStreams[message.facadeId];
                }
                break;
            }

            default:
                break;

        }

    }

    port.addEventListener('message', handleMessage);

};

// Auto-install when loaded in a worker context.
if (Guacamole.WorkerBootstrap.isWorkerContext())
    Guacamole.WorkerBootstrap.install(self);
