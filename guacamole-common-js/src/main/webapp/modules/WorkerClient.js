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
 * Guacamole protocol client that runs the underlying Tunnel, Parser, and
 * Display within a dedicated Web Worker rather than on the main thread.
 * Its public API is a subset of {@link Guacamole.Client} with stream-proxy
 * support added incrementally; code that does not use stream-bearing Client
 * callbacks can treat this class as a drop-in alternative.
 *
 * The opt-in to the worker path is explicit: consumers that construct a
 * Guacamole.Client continue to receive exactly the previous behavior, with
 * all protocol parsing and rendering performed on the main thread. Only
 * consumers that deliberately construct a Guacamole.WorkerClient will see
 * the widened contract around layer canvas types (HTMLCanvasElement or
 * OffscreenCanvas) that results from the worker-backed implementation.
 *
 * @constructor
 *
 * @param {!Object} options
 *     Configuration for this WorkerClient.
 *
 * @param {!string} options.workerUrl
 *     The absolute (or root-relative) URL of the worker script to spawn.
 *     This script must load the Guacamole common-js library (for example
 *     via importScripts of the concatenated all.js) such that
 *     {@link Guacamole.WorkerBootstrap} is evaluated and auto-installs in
 *     the worker context.
 *
 * @param {!Object} options.tunnel
 *     A tunnel descriptor consumed by {@link Guacamole.WorkerBootstrap}.
 *     The descriptor must contain a "type" field ("websocket", "http", or
 *     "static-http") along with the corresponding URL and any additional
 *     type-specific options. URLs must be absolute; use
 *     {@link Guacamole.WorkerClient.resolveUrl} when converting from a
 *     relative URL on the main thread.
 *
 * @param {Object} [options.debug]
 *     Optional diagnostic flags forwarded to the worker. Recognized keys:
 *     `logging` (boolean) — when true, the worker-side
 *     {@link Guacamole.Client.debugTiming} flag is enabled, causing
 *     sync-timing, state-change, and error events to be written to the
 *     worker's console. This is parallel to enabling the same flag on
 *     the main thread so that the same log format is emitted from both
 *     contexts.
 */
Guacamole.WorkerClient = function WorkerClient(options) {

    var client = this;

    if (!options || !options.workerUrl)
        throw new Error('Guacamole.WorkerClient requires a workerUrl option.');
    if (!options.tunnel)
        throw new Error('Guacamole.WorkerClient requires a tunnel option.');

    /**
     * The dedicated Web Worker that runs the Guacamole protocol client.
     *
     * @private
     * @type {!Worker}
     */
    var worker = new Worker(options.workerUrl);

    // Surface any worker-loading or uncaught worker-side errors out as
    // client-level errors so that consumers can react rather than
    // silently failing to connect.
    worker.addEventListener('error', function workerLoadError(event) {
        if (client.onerror)
            client.onerror({
                code: 0,
                message: event.message
                        ? 'Worker error: ' + event.message
                        : 'Worker failed to load or threw an uncaught error.'
            });
    });

    worker.addEventListener('messageerror', function workerMessageError() {
        if (client.onerror)
            client.onerror({
                code: 0,
                message: 'Worker message channel deserialization error.'
            });
    });

    /**
     * Main-thread receiver for compositor messages posted by the worker.
     *
     * @private
     * @type {!Guacamole.Display.WorkerStageHost}
     */
    var host = new Guacamole.Display.WorkerStageHost(worker);

    /**
     * The last state reported by the worker-side Client. Tracked so that
     * queries such as isConnected() can respond without a round-trip.
     *
     * @private
     * @type {!number}
     */
    var currentState = Guacamole.Client.State.IDLE;

    /**
     * The logical display width last reported by the worker-side Display,
     * in pixels.
     *
     * @private
     * @type {!number}
     */
    var currentDisplayWidth = 0;

    /**
     * The logical display height last reported by the worker-side Display,
     * in pixels.
     *
     * @private
     * @type {!number}
     */
    var currentDisplayHeight = 0;

    /**
     * The statistic window last assigned via displayFacade.statisticWindow.
     * Mirrored here so reads are local and so that the value can be
     * propagated to the worker on assignment.
     *
     * @private
     * @type {!number}
     */
    var currentStatisticWindow = 0;

    /**
     * Recomputes the outer bounds size of the display based on the most
     * recently-known display dimensions and scale, and applies it via the
     * main-thread {@link Guacamole.Display.DOMStage}. Invoked whenever
     * either display dimensions or scale changes.
     *
     * @private
     */
    function applyBoundsSize() {
        var stage = host.getDOMStage();
        var scale = stage.getScale() || 1;
        stage.setBoundsSize(currentDisplayWidth * scale, currentDisplayHeight * scale);
    }

    /**
     * Main-thread facade that mimics the relevant portion of
     * {@link Guacamole.Display}, delegating DOM and compositor operations
     * to the main-thread stage while tracking dimensions reported by the
     * worker-side Display.
     *
     * @private
     */
    var displayFacade = {

        /**
         * @returns {!Element}
         */
        getElement: function getElement() {
            return host.getElement();
        },

        /**
         * @returns {!number}
         */
        getWidth: function getWidth() {
            return currentDisplayWidth;
        },

        /**
         * @returns {!number}
         */
        getHeight: function getHeight() {
            return currentDisplayHeight;
        },

        /**
         * @param {!number} scale
         */
        scale: function scale(s) {
            host.getDOMStage().setScale(s);
            applyBoundsSize();
        },

        /**
         * @returns {!number}
         */
        getScale: function getScale() {
            return host.getDOMStage().getScale();
        },

        /**
         * @param {boolean} [shown=true]
         */
        showCursor: function showCursor(shown) {
            worker.postMessage({
                type: 'display.showCursor',
                shown: shown
            });
        },

        /**
         * @returns {!HTMLCanvasElement}
         */
        flatten: function flatten() {
            // Flatten is not currently supported on worker-backed
            // displays because it requires cross-boundary composition of
            // every visible layer. Returns an empty canvas so that
            // consumers calling flatten() for thumbnail or export purposes
            // degrade gracefully. Proper support can be added by routing
            // the call to the worker and awaiting a VideoFrame/ImageBitmap
            // via postMessage.
            var canvas = Guacamole.Layer.createBackingCanvas(
                    currentDisplayWidth, currentDisplayHeight);
            return canvas;
        },

        /**
         * Fired when the remote display is resized.
         * @event
         * @param {!number} width
         * @param {!number} height
         */
        onresize: null,

        /**
         * Fired when the cursor image changes.
         * @event
         * @param {!(HTMLCanvasElement|OffscreenCanvas|ImageBitmap)} canvas
         * @param {!number} x
         * @param {!number} y
         */
        oncursor: null,

        /**
         * Fired whenever performance statistics become available from the
         * worker-side {@link Guacamole.Display}. Only fires when
         * {@link #statisticWindow} is non-zero.
         *
         * @event
         * @param {!Guacamole.Display.Statistics} stats
         */
        onstatistics: null

    };

    // statisticWindow is exposed as a property on the facade so that
    // existing consumers (notably the guacamole-display-statistics
    // extension) can assign to it using the same syntax as on an
    // ordinary Guacamole.Display. Assignment propagates the value across
    // the worker boundary so the worker-side Display actually gathers
    // statistics.
    Object.defineProperty(displayFacade, 'statisticWindow', {
        enumerable: true,
        configurable: false,
        get: function () { return currentStatisticWindow; },
        set: function (value) {
            currentStatisticWindow = value;
            worker.postMessage({
                type: 'display.setStatisticWindow',
                window: value
            });
        }
    });

    /**
     * Main-thread facade that mimics the relevant portion of
     * {@link Guacamole.Tunnel}, forwarding any tunnel-level events from
     * the worker and exposing the tunnel UUID once assigned.
     *
     * @type {!Object}
     */
    this.tunnel = {

        /**
         * The UUID assigned to this tunnel by the Guacamole server, if
         * known. Until an onuuid event has fired, this will be null.
         *
         * @type {?string}
         */
        uuid: null,

        /**
         * The current state of this tunnel, as one of the values defined
         * by {@link Guacamole.Tunnel.State}.
         *
         * @type {!number}
         */
        state: Guacamole.Tunnel.State.CLOSED,

        /**
         * Fired when the tunnel reports an error.
         * @event
         * @param {!Guacamole.Status} status
         */
        onerror: null,

        /**
         * Fired when the tunnel has been assigned a UUID.
         * @event
         * @param {!string} uuid
         */
        onuuid: null,

        /**
         * Fired when the tunnel transitions between states.
         * @event
         * @param {!number} state
         */
        onstatechange: null

    };

    /**
     * Proxied {@link Guacamole.InputStream} facades created on behalf of
     * inbound streams announced by the worker. Keyed by the worker's
     * stream index.
     *
     * @private
     * @type {!Object.<number, !Guacamole.InputStream>}
     */
    var facadeInputStreams = {};

    /**
     * Proxied {@link Guacamole.OutputStream} facades created by the main-
     * thread consumer. Keyed by the locally-assigned facadeId (used to
     * correlate messages with the worker) rather than the stream index
     * that the worker ultimately assigns, since the facade must be usable
     * immediately — before the round-trip to the worker has completed.
     *
     * @private
     * @type {!Object.<number, {stream: !Guacamole.OutputStream, facadeId: !number}>}
     */
    var facadeOutputStreams = {};

    /**
     * The next facadeId to assign to an outbound stream created by this
     * client.
     *
     * @private
     * @type {!number}
     */
    var nextFacadeId = 1;

    /**
     * Constructs a main-thread InputStream facade corresponding to a
     * worker-side Guacamole.InputStream identified by the given stream
     * index. Blob and end events arriving from the worker are routed to
     * this facade's onblob/onend handlers; acknowledgments sent via the
     * facade's sendAck are forwarded back to the worker.
     *
     * @private
     * @param {!number} streamIndex
     * @returns {!Guacamole.InputStream}
     */
    function createInputFacade(streamIndex) {

        // Construct a real Guacamole.InputStream whose sendAck happens to
        // be rerouted via postMessage rather than a real Client.sendAck.
        // We give the InputStream a minimal "client" object that satisfies
        // the sendAck contract.
        var fakeClient = {
            sendAck: function facadeSendAck(index, message, code) {
                worker.postMessage({
                    type: 'sendAck',
                    streamIndex: index,
                    message: message,
                    code: code
                });
            }
        };

        var stream = new Guacamole.InputStream(fakeClient, streamIndex);
        facadeInputStreams[streamIndex] = stream;
        return stream;

    }

    /**
     * Constructs a main-thread OutputStream facade corresponding to an
     * outbound stream to be created on the worker side.
     *
     * @private
     * @param {!string} streamType
     *     One of 'audio', 'clipboard', 'file', 'pipe', 'argv', 'output'.
     *
     * @param {Object} [creationArgs]
     *     Extra parameters required by the stream type (e.g. mimetype,
     *     filename, name). Forwarded to the worker as-is.
     *
     * @returns {!Guacamole.OutputStream}
     *     A facade OutputStream whose sendBlob/sendEnd delegate to the
     *     worker and whose onack fires when the worker reports an
     *     acknowledgement from the server.
     */
    function createOutputFacade(streamType, creationArgs) {

        var facadeId = nextFacadeId++;

        // The facade carries its facadeId as the "index" so that
        // consumers observe a stable integer identifier. The real stream
        // index is tracked internally once the worker assigns it.
        var fakeClient = {
            sendBlob: function facadeSendBlob(index, data) {
                worker.postMessage({
                    type: 'sendBlob',
                    facadeId: facadeId,
                    data: data
                });
            },
            endStream: function facadeEndStream(index) {
                worker.postMessage({
                    type: 'sendEnd',
                    facadeId: facadeId
                });
                delete facadeOutputStreams[facadeId];
            }
        };

        var stream = new Guacamole.OutputStream(fakeClient, facadeId);
        facadeOutputStreams[facadeId] = { stream: stream, facadeId: facadeId };

        // Ask the worker to actually create the corresponding Client-side
        // stream. Any subsequent sendBlob / sendEnd messages are buffered
        // by the worker's message queue and processed after the stream is
        // instantiated, so there is no need to delay the return of this
        // facade to the caller.
        var createMessage = {
            type: 'createStream',
            facadeId: facadeId,
            streamType: streamType
        };
        if (creationArgs) {
            for (var key in creationArgs)
                createMessage[key] = creationArgs[key];
        }
        worker.postMessage(createMessage);

        return stream;

    }

    //
    // Callbacks mirrored from Guacamole.Client
    //

    /**
     * Fired whenever the state of this client changes.
     *
     * @event
     * @param {!number} state
     *     The new client state, one of the values enumerated by
     *     {@link Guacamole.Client.State}.
     */
    this.onstatechange = null;

    /**
     * Fired whenever an error is reported by the remote end.
     *
     * @event
     * @param {!Guacamole.Status} status
     */
    this.onerror = null;

    /**
     * Fired when the remote end reports a connection name.
     *
     * @event
     * @param {!string} name
     */
    this.onname = null;

    /**
     * Fired when the remote end reports a sync instruction.
     *
     * @event
     * @param {!number} timestamp
     * @param {!number} frames
     */
    this.onsync = null;

    /**
     * Fired when the remote end requests additional connection parameters.
     *
     * @event
     * @param {!string[]} parameters
     */
    this.onrequired = null;

    /**
     * Fired when another user joins the connection.
     *
     * @event
     * @param {!string} id
     * @param {!string} name
     */
    this.onjoin = null;

    /**
     * Fired when another user leaves the connection.
     *
     * @event
     * @param {!string} id
     */
    this.onleave = null;

    /**
     * Fired when the remote end declares multi-touch support.
     *
     * @event
     * @param {!{layerContainerId: ?number, touches: number}} info
     */
    this.onmultitouch = null;

    //
    // Stream-bearing callbacks. These fire with partial metadata for now;
    // full Guacamole.InputStream/OutputStream proxying is the subject of a
    // separate task and will replace these signatures with complete ones.
    //

    /**
     * Fired when a new audio stream is announced by the remote end. The
     * current implementation provides only metadata; stream-data proxying
     * is a follow-up task.
     *
     * @event
     * @param {!{streamIndex: number, mimetype: string}} info
     */
    this.onaudio = null;

    /**
     * Fired when a new clipboard stream is announced. Same stream-proxy
     * caveat as onaudio.
     *
     * @event
     * @param {!{streamIndex: number, mimetype: string}} info
     */
    this.onclipboard = null;

    /**
     * Fired when a new file stream is announced. Same stream-proxy caveat.
     *
     * @event
     * @param {!{streamIndex: number, mimetype: string, filename: string}} info
     */
    this.onfile = null;

    /**
     * Fired when a new filesystem object is announced. Same stream-proxy
     * caveat.
     *
     * @event
     * @param {!{objectIndex: number, name: string}} info
     */
    this.onfilesystem = null;

    /**
     * Fired when a new pipe stream is announced. Same stream-proxy caveat.
     *
     * @event
     * @param {!{streamIndex: number, mimetype: string, name: string}} info
     */
    this.onpipe = null;

    /**
     * Fired when a new argument-value stream is announced. Same stream-proxy
     * caveat.
     *
     * @event
     * @param {!{streamIndex: number, mimetype: string, name: string}} info
     */
    this.onargv = null;

    /**
     * Fired when a video stream is announced. Same stream-proxy caveat.
     *
     * @event
     * @param {!{streamIndex: number, layerContainerId: ?number, mimetype: string}} info
     */
    this.onvideo = null;

    //
    // Public API
    //

    /**
     * Returns the outer DOM element through which the worker's rendered
     * output is displayed. Consumers should attach this element to the
     * document in order to see the Guacamole display.
     *
     * @returns {!Element}
     */
    this.getElement = function getElement() {
        return host.getElement();
    };

    /**
     * Returns the main-thread DOMStage through which worker-produced
     * content is composited. This is analogous to
     * {@link Guacamole.Client#getDisplay} except that pixel drawing
     * originates from the worker; consumers should not issue drawing
     * operations against this stage directly.
     *
     * @returns {!Guacamole.Display.DOMStage}
     */
    this.getDisplayStage = function getDisplayStage() {
        return host.getDOMStage();
    };

    /**
     * Returns a Guacamole.Display-shaped facade that allows consumers
     * familiar with the main-thread Client API to query and manipulate
     * the worker-backed display without knowing it is a worker-backed
     * display. Supported operations: getElement, getWidth, getHeight,
     * scale, getScale, showCursor, flatten (currently returns an empty
     * canvas), and the onresize/oncursor callbacks.
     *
     * @returns {!Object}
     */
    this.getDisplay = function getDisplay() {
        return displayFacade;
    };

    /**
     * Returns the most recently-reported state of the client, as described
     * by {@link Guacamole.Client.State}.
     *
     * @returns {!number}
     */
    this.getState = function getState() {
        return currentState;
    };

    /**
     * Returns whether this client is currently in a state from which it can
     * send outbound instructions (connected or waiting).
     *
     * @returns {!boolean}
     */
    var isConnected = function isConnected() {
        return currentState === Guacamole.Client.State.CONNECTED
            || currentState === Guacamole.Client.State.WAITING;
    };

    /**
     * Asks the worker to begin a Guacamole protocol connection. The given
     * data is forwarded as-is to {@link Guacamole.Client#connect} running
     * within the worker.
     *
     * @param {string} [data]
     */
    this.connect = function connect(data) {
        worker.postMessage({ type: 'connect', data: data });
    };

    /**
     * Asks the worker to terminate its Guacamole protocol connection.
     */
    this.disconnect = function disconnect() {
        worker.postMessage({ type: 'disconnect' });
    };

    /**
     * Sends a key event to the worker, which forwards it via its internal
     * Client.
     *
     * @param {!number} pressed
     *     1 if the key is pressed, 0 if released.
     * @param {!number} keysym
     *     The X11 keysym of the key.
     */
    this.sendKeyEvent = function sendKeyEvent(pressed, keysym) {
        if (!isConnected())
            return;
        worker.postMessage({
            type: 'sendKeyEvent',
            pressed: pressed,
            keysym: keysym
        });
    };

    /**
     * Sends a mouse state to the worker. If applyDisplayScale is true, the
     * coordinates are divided by the current display scale on the main
     * thread before being sent so that the worker receives coordinates in
     * the remote desktop's coordinate space.
     *
     * @param {!Guacamole.Mouse.State} mouseState
     * @param {boolean} [applyDisplayScale=false]
     */
    this.sendMouseState = function sendMouseState(mouseState, applyDisplayScale) {
        if (!isConnected())
            return;

        var x = mouseState.x;
        var y = mouseState.y;
        if (applyDisplayScale) {
            var scale = host.getDOMStage().getScale() || 1;
            x /= scale;
            y /= scale;
        }

        worker.postMessage({
            type: 'sendMouseState',
            state: {
                x: x,
                y: y,
                left: mouseState.left,
                middle: mouseState.middle,
                right: mouseState.right,
                up: mouseState.up,
                down: mouseState.down
            }
        });
    };

    /**
     * Sends a touch state to the worker.
     *
     * @param {!Guacamole.Touch.State} touchState
     * @param {boolean} [applyDisplayScale=false]
     */
    this.sendTouchState = function sendTouchState(touchState, applyDisplayScale) {
        if (!isConnected())
            return;

        var x = touchState.x;
        var y = touchState.y;
        if (applyDisplayScale) {
            var scale = host.getDOMStage().getScale() || 1;
            x /= scale;
            y /= scale;
        }

        worker.postMessage({
            type: 'sendTouchState',
            state: {
                id: touchState.id,
                x: x,
                y: y,
                radiusX: touchState.radiusX,
                radiusY: touchState.radiusY,
                angle: touchState.angle,
                force: touchState.force
            }
        });
    };

    /**
     * Sends a new display size to the remote end via the worker.
     *
     * @param {!number} width
     * @param {!number} height
     */
    this.sendSize = function sendSize(width, height) {
        worker.postMessage({
            type: 'sendSize',
            width: width,
            height: height
        });
    };

    /**
     * Opens a new audio output stream. Returns a
     * {@link Guacamole.OutputStream} facade; blob/end operations are
     * forwarded to the worker-side Client, and acknowledgments from the
     * server are returned via onack.
     *
     * @param {!string} mimetype
     * @returns {!Guacamole.OutputStream}
     */
    this.createAudioStream = function createAudioStream(mimetype) {
        return createOutputFacade('audio', { mimetype: mimetype });
    };

    /**
     * Opens a new clipboard output stream.
     *
     * @param {!string} mimetype
     * @returns {!Guacamole.OutputStream}
     */
    this.createClipboardStream = function createClipboardStream(mimetype) {
        return createOutputFacade('clipboard', { mimetype: mimetype });
    };

    /**
     * Opens a new file output stream.
     *
     * @param {!string} mimetype
     * @param {!string} filename
     * @returns {!Guacamole.OutputStream}
     */
    this.createFileStream = function createFileStream(mimetype, filename) {
        return createOutputFacade('file', {
            mimetype: mimetype,
            filename: filename
        });
    };

    /**
     * Opens a new pipe output stream.
     *
     * @param {!string} mimetype
     * @param {!string} name
     * @returns {!Guacamole.OutputStream}
     */
    this.createPipeStream = function createPipeStream(mimetype, name) {
        return createOutputFacade('pipe', {
            mimetype: mimetype,
            name: name
        });
    };

    /**
     * Opens a new argument-value output stream.
     *
     * @param {!string} mimetype
     * @param {!string} name
     * @returns {!Guacamole.OutputStream}
     */
    this.createArgumentValueStream = function createArgumentValueStream(mimetype, name) {
        return createOutputFacade('argv', {
            mimetype: mimetype,
            name: name
        });
    };

    /**
     * Opens a new, unassociated output stream. The returned stream has no
     * mimetype or type-specific metadata; the caller is expected to drive
     * the stream manually.
     *
     * @returns {!Guacamole.OutputStream}
     */
    this.createOutputStream = function createOutputStream() {
        return createOutputFacade('output', null);
    };

    /**
     * Terminates the worker immediately. Subsequent calls to any other
     * method on this instance will have no effect.
     */
    this.terminate = function terminate() {
        host.dispose();
        worker.terminate();
    };

    //
    // Message handling
    //

    host.onmessage = function onHostMessage(message) {

        if (!message || typeof message.type !== 'string')
            return;

        switch (message.type) {

            case 'ready':
                // Worker is ready to receive commands. We've already posted
                // the init message; nothing further needed here.
                break;

            case 'error':
                if (client.onerror)
                    client.onerror({ code: 0, message: message.message });
                break;

            case 'client.statechange':
                currentState = message.state;
                if (client.onstatechange)
                    client.onstatechange(message.state);
                break;

            case 'client.error':
                if (client.onerror)
                    client.onerror(message.status);
                break;

            case 'client.name':
                if (client.onname)
                    client.onname(message.name);
                break;

            case 'client.sync':
                if (client.onsync)
                    client.onsync(message.timestamp, message.frames);
                break;

            case 'client.required':
                if (client.onrequired)
                    client.onrequired(message.parameters);
                break;

            case 'client.join':
                if (client.onjoin)
                    client.onjoin(message.id, message.name);
                break;

            case 'client.leave':
                if (client.onleave)
                    client.onleave(message.id);
                break;

            case 'client.audio': {
                var stream = createInputFacade(message.streamIndex);
                if (client.onaudio)
                    client.onaudio(stream, message.mimetype);
                break;
            }

            case 'client.clipboard': {
                var stream = createInputFacade(message.streamIndex);
                if (client.onclipboard)
                    client.onclipboard(stream, message.mimetype);
                break;
            }

            case 'client.file': {
                var stream = createInputFacade(message.streamIndex);
                if (client.onfile)
                    client.onfile(stream, message.mimetype, message.filename);
                break;
            }

            case 'client.pipe': {
                var stream = createInputFacade(message.streamIndex);
                if (client.onpipe)
                    client.onpipe(stream, message.mimetype, message.name);
                break;
            }

            case 'client.argv': {
                var stream = createInputFacade(message.streamIndex);
                if (client.onargv)
                    client.onargv(stream, message.mimetype, message.name);
                break;
            }

            case 'client.filesystem':
                // Filesystem objects are metadata-only for now; the
                // consumer receives the raw announcement.
                if (client.onfilesystem)
                    client.onfilesystem(message);
                break;

            case 'client.video':
                // Video stream metadata is forwarded for now; a future
                // implementation may provide a full InputStream facade
                // once layer-reference proxying is in place.
                if (client.onvideo)
                    client.onvideo(message);
                break;

            case 'stream.blob': {
                var facade = facadeInputStreams[message.streamIndex];
                if (facade && facade.onblob)
                    facade.onblob(message.data);
                break;
            }

            case 'stream.end': {
                var facade = facadeInputStreams[message.streamIndex];
                if (facade) {
                    if (facade.onend)
                        facade.onend();
                    delete facadeInputStreams[message.streamIndex];
                }
                break;
            }

            case 'stream.ack': {
                var entry = facadeOutputStreams[message.facadeId];
                if (entry && entry.stream.onack) {
                    var statusInfo = message.status || {};
                    entry.stream.onack(new Guacamole.Status(
                            statusInfo.code, statusInfo.message));
                }
                if (message.status && message.status.code >= 0x0100)
                    delete facadeOutputStreams[message.facadeId];
                break;
            }

            case 'stream.created':
                // The worker has assigned a real stream index. No action
                // is required on the main thread today; the mapping is
                // retained here for potential future use (for example to
                // allow consumers to query the real stream index).
                break;

            case 'client.multitouch':
                if (client.onmultitouch)
                    client.onmultitouch(message);
                break;

            case 'tunnel.uuid':
                client.tunnel.uuid = message.uuid;
                if (client.tunnel.onuuid)
                    client.tunnel.onuuid(message.uuid);
                break;

            case 'tunnel.statechange':
                client.tunnel.state = message.state;
                if (client.tunnel.onstatechange)
                    client.tunnel.onstatechange(message.state);
                break;

            case 'tunnel.error':
                if (client.tunnel.onerror)
                    client.tunnel.onerror(message.status);
                break;

            case 'display.resize':
                currentDisplayWidth = message.width;
                currentDisplayHeight = message.height;
                // Recompute the outer bounds size to reflect the new display
                // dimensions combined with the current main-thread scale.
                // This is the piece the worker can't do on its own, since
                // scale is kept main-thread-side only.
                applyBoundsSize();
                if (displayFacade.onresize)
                    displayFacade.onresize(message.width, message.height);
                break;

            case 'display.cursor': {
                if (!displayFacade.oncursor) {
                    if (message.bitmap && typeof message.bitmap.close === 'function')
                        message.bitmap.close();
                    break;
                }

                if (!message.bitmap) {
                    displayFacade.oncursor(null, message.x, message.y);
                    break;
                }

                // Convert the incoming ImageBitmap to a main-thread
                // HTMLCanvasElement. Guacamole.Mouse.setCursor (and other
                // consumers) call toDataURL() on the cursor canvas, which
                // is not available on ImageBitmap instances.
                var cursorCanvas = document.createElement('canvas');
                cursorCanvas.width = message.bitmap.width;
                cursorCanvas.height = message.bitmap.height;
                cursorCanvas.getContext('2d').drawImage(message.bitmap, 0, 0);
                message.bitmap.close();

                displayFacade.oncursor(cursorCanvas, message.x, message.y);
                break;
            }

            case 'display.statistics':
                // Statistics are a Display-level concern. Route through
                // the display facade to match the shape of the original
                // Guacamole.Display API, where consumers assign to
                // display.onstatistics rather than client.onstatistics.
                if (displayFacade.onstatistics)
                    displayFacade.onstatistics(
                            new Guacamole.Display.Statistics(message.stats));
                break;

            case 'frame':
                // Frame boundary from worker. No-op at this layer; frame
                // statistics arrive via display.statistics messages.
                break;

            case 'stage.playVideo':
                // Video playback fallback will be implemented in a separate
                // task. For now, ignore.
                break;

            default:
                break;

        }

    };

    // Kick off worker initialization
    worker.postMessage({
        type: 'init',
        tunnel: options.tunnel,
        debug: options.debug || null
    });

};

/**
 * Resolves the given URL relative to the current document location,
 * returning an absolute URL suitable for inclusion in a tunnel descriptor
 * passed to {@link Guacamole.WorkerClient}. WebSocket URLs are adjusted to
 * use the current page's ws:/wss: scheme.
 *
 * @param {!string} url
 *     The (possibly relative) URL to resolve.
 *
 * @param {string} [scheme]
 *     Optional explicit scheme to apply to the resolved URL. Useful when
 *     resolving a relative URL to a WebSocket endpoint: pass "ws" or
 *     "wss" as appropriate. If omitted, the URL's resolved scheme is
 *     preserved.
 *
 * @returns {!string}
 *     The absolute URL.
 */
Guacamole.WorkerClient.resolveUrl = function resolveUrl(url, scheme) {

    var absolute = new URL(url, window.location.href);

    if (scheme) {
        var trimmedScheme = scheme.replace(/:$/, '');
        if (trimmedScheme === 'ws' || trimmedScheme === 'wss') {
            var wsUrl = absolute.toString();
            if (wsUrl.substring(0, 5) === 'http:')
                wsUrl = 'ws:' + wsUrl.substring(5);
            else if (wsUrl.substring(0, 6) === 'https:')
                wsUrl = 'wss:' + wsUrl.substring(6);
            return wsUrl;
        }
        absolute.protocol = trimmedScheme + ':';
    }

    return absolute.toString();

};
