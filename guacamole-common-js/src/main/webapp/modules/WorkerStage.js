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
 * A {@link Guacamole.Display.Stage} implementation intended for use within a
 * Web Worker. Rather than manipulating the DOM directly (which is not
 * available within a Worker context), a WorkerStage serializes all DOM
 * operations as postMessage events directed at a paired
 * {@link Guacamole.Display.WorkerStageHost} running on the main thread. The
 * host performs the actual DOM manipulation on the worker's behalf.
 *
 * Visible layers are rendered entirely within the Worker, using OffscreenCanvas
 * as the backing canvas for each {@link Guacamole.Layer}. At the end of each
 * frame, the contents of every dirty visible layer are captured as an
 * ImageBitmap and transferred to the main thread, where they are composited
 * onto the appropriate visible HTMLCanvasElement managed by the host.
 *
 * @constructor
 * @augments Guacamole.Display.Stage
 *
 * @param {!(Worker|DedicatedWorkerGlobalScope|MessagePort)} port
 *     The object to which messages are posted and from which they are
 *     received. Within a Web Worker this is typically the global self.
 */
Guacamole.Display.WorkerStage = function WorkerStage(port) {

    var stage = this;

    /**
     * Next container identifier to assign. Container identifiers are
     * monotonically increasing and unique within a single WorkerStage
     * instance.
     *
     * @private
     * @type {!number}
     */
    var nextContainerId = 1;

    /**
     * Every visible layer container that has ever been created by this stage,
     * keyed by container identifier. Buffer-layer containers are not tracked,
     * as they are never displayed.
     *
     * @private
     * @type {!Object.<number, Guacamole.Display.WorkerStage.LayerContainer>}
     */
    var containers = {};

    /**
     * Posts a message to the paired
     * {@link Guacamole.Display.WorkerStageHost}. Used internally by the stage
     * and its layer containers to serialize DOM operations across the worker
     * boundary.
     *
     * @private
     * @param {!Object} message
     *     The message to post. Must be structured-cloneable.
     *
     * @param {Transferable[]} [transfer]
     *     Any transferable objects contained within the message.
     */
    stage.__post = function __post(message, transfer) {
        if (transfer)
            port.postMessage(message, transfer);
        else
            port.postMessage(message);
    };

    /**
     * Removes the given container identifier from the set of containers
     * tracked by this stage. Called by {@link
     * Guacamole.Display.WorkerStage.LayerContainer#dispose}.
     *
     * @private
     * @param {!number} containerId
     */
    stage.__unregisterContainer = function __unregisterContainer(containerId) {
        delete containers[containerId];
    };

    /**
     * Called by the owning {@link Guacamole.Display} whenever a frame
     * boundary has been crossed. Captures the current contents of every
     * visible layer as an ImageBitmap, posts each to the main thread, and
     * signals the frame boundary itself so that main-thread statistics and
     * events can fire. All known visible containers are captured; a finer-
     * grained dirty-tracking mechanism may be introduced later if capture
     * volume becomes an issue.
     *
     * @param {number} [localTimestamp]
     *     The local timestamp of the frame just rendered, in milliseconds
     *     since the Unix Epoch. Forwarded to the main thread for statistics
     *     purposes.
     *
     * @param {number} [remoteTimestamp]
     *     The remote timestamp of the frame just rendered. Forwarded to the
     *     main thread for statistics purposes.
     *
     * @param {number} [logicalFrames]
     *     The number of remote desktop frames combined to produce this frame,
     *     as reported by the Guacamole server. Forwarded to the main thread
     *     for statistics purposes.
     */
    this.onFrameFlushed = function onFrameFlushed(localTimestamp, remoteTimestamp, logicalFrames) {

        // Capture every known visible layer. Each capture returns a
        // Promise that resolves once the bitmap has been posted via
        // postMessage, so that the frame sentinel below is guaranteed to
        // be delivered to the main thread strictly after all of this
        // frame's bitmaps.
        var captures = [];
        for (var idString in containers) {
            var container = containers[idString];
            if (container)
                captures.push(container.__captureAndPost());
        }

        // Signal to the main thread that a frame boundary has passed.
        // Posted only after every bitmap for this frame has been
        // postMessage'd so that the sentinel arrives last in order; the
        // main thread uses this to emit a single aligned frame-timing
        // log line once the frame is visibly complete.
        Promise.all(captures).then(function framePosted() {
            stage.__post({
                type: 'frame',
                localTimestamp: localTimestamp,
                remoteTimestamp: remoteTimestamp,
                logicalFrames: logicalFrames
            });
        });

    };

    //
    // Implementation of Guacamole.Display.Stage
    //

    /**
     * Returns null. Within a Worker there is no DOM element that could be
     * meaningfully returned.
     *
     * @returns {null}
     */
    this.getRootElement = function getRootElement() {
        return null;
    };

    this.setDisplaySize = function setDisplaySize(width, height) {
        stage.__post({
            type: 'stage.setDisplaySize',
            width: width,
            height: height
        });
    };

    /**
     * The bounds size is a function of the logical display dimensions and
     * the current display scale. Scale is a main-thread-only CSS concern
     * that the worker does not track; the main-thread host therefore
     * computes and applies bounds size itself, so this stage method is a
     * no-op.
     */
    this.setBoundsSize = function setBoundsSize() {
        // Intentionally no-op; see above.
    };

    /**
     * Display scale is purely a main-thread CSS transform. The WorkerClient
     * facade owns it directly, so no message need cross the worker
     * boundary when scale changes.
     */
    this.setScale = function setScale() {
        // Intentionally no-op; see above.
    };

    this.attachTopLevelLayer = function attachTopLevelLayer(layer) {
        var container = layer.__getContainer();
        stage.__post({
            type: 'stage.attachTopLevelLayer',
            containerId: container.__id
        });
    };

    this.detachTopLevelLayer = function detachTopLevelLayer(layer) {
        var container = layer.__getContainer();
        stage.__post({
            type: 'stage.detachTopLevelLayer',
            containerId: container.__id
        });
    };

    this.createLayerContainer = function createLayerContainer(canvas, width, height) {
        var id = nextContainerId++;
        var container = new Guacamole.Display.WorkerStage.LayerContainer(stage, id, canvas, width, height);
        containers[id] = container;
        stage.__post({
            type: 'stage.createLayerContainer',
            containerId: id,
            width: width,
            height: height
        });
        return container;
    };

    /**
     * Parses a data: URL into its mimetype and raw byte payload.
     *
     * @private
     * @param {!string} url
     *     The data: URL to parse.
     *
     * @returns {?{mimetype: string, bytes: Uint8Array}}
     *     An object containing the mimetype and byte payload of the given
     *     data: URL, or null if the given string is not a data: URL.
     */
    function parseDataUrl(url) {

        if (!url || url.substring(0, 5) !== 'data:')
            return null;

        var comma = url.indexOf(',');
        if (comma < 0)
            return null;

        var header = url.substring(5, comma);
        var payload = url.substring(comma + 1);

        var mimetype = header;
        var isBase64 = false;

        var semi = header.indexOf(';');
        if (semi >= 0) {
            mimetype = header.substring(0, semi);
            isBase64 = header.indexOf(';base64', semi) >= 0;
        }

        var bytes;
        if (isBase64) {
            var binary = atob(payload);
            bytes = new Uint8Array(binary.length);
            for (var i = 0; i < binary.length; i++)
                bytes[i] = binary.charCodeAt(i);
        }
        else
            bytes = new TextEncoder().encode(decodeURIComponent(payload));

        return { mimetype: mimetype, bytes: bytes };

    }

    this.decodeUrl = function decodeUrl(url) {

        var parsed = parseDataUrl(url);
        if (!parsed) {
            // Non-data URLs cannot be decoded within a Worker without
            // fetching, which is outside the scope of decodeUrl. Resolve to
            // a placeholder so that the frame is still flushed.
            return Promise.resolve(null);
        }

        if (typeof ImageDecoder === 'undefined')
            return Promise.resolve(null);

        var decoder = new ImageDecoder({
            type: parsed.mimetype,
            data: parsed.bytes
        });

        return decodeAndClose(decoder);

    };

    this.decodeBlob = function decodeBlob(blob, mimetype) {

        var type = mimetype || (blob && blob.type);
        if (!type || typeof ImageDecoder === 'undefined')
            return Promise.resolve(null);

        var decoder = new ImageDecoder({
            type: type,
            data: blob.stream()
        });

        return decodeAndClose(decoder);

    };

    this.decodeStream = function decodeStream(stream, mimetype) {

        if (typeof ImageDecoder === 'undefined' || typeof ReadableStream === 'undefined') {
            // Fall back to collecting the stream as a data URI, then
            // decoding via decodeUrl. This loses the streaming-decode
            // advantage but preserves correctness.
            return new Promise(function decodeStreamViaDataURI(resolve) {
                var reader = new Guacamole.DataURIReader(stream, mimetype);
                reader.onend = function dataURIComplete() {
                    stage.decodeUrl(reader.getURI()).then(resolve);
                };
            });
        }

        var decoder = new ImageDecoder({
            type: mimetype,
            data: stream.toReadableStream()
        });

        return decodeAndClose(decoder);

    };

    /**
     * Decodes a single complete frame from the given ImageDecoder,
     * explicitly closing the decoder once the decode operation has
     * resolved (or failed). Closing is required to release the
     * decoder's internal buffers and backend resources; browsers do not
     * reclaim these via ordinary garbage collection.
     *
     * @private
     * @param {!ImageDecoder} decoder
     * @returns {!Promise.<?VideoFrame>}
     */
    function decodeAndClose(decoder) {

        // ImageDecoder exposes a .completed promise that rejects with
        // "Closed decoder" if the decoder is closed before its input
        // stream has been fully processed. Closing here is eager (once
        // the single complete frame we requested has been returned), so
        // the completed promise will almost always reject. Attach a
        // no-op handler so that rejection isn't surfaced as an uncaught
        // promise rejection.
        if (decoder.completed && typeof decoder.completed.catch === 'function')
            decoder.completed.catch(function ignoreCompletedRejection() {});

        return decoder.decode({ completeFramesOnly: true }).then(
            function decoded(result) {
                decoder.close();
                return result.image;
            },
            function decodeFailed() {
                decoder.close();
                return null;
            }
        );
    }

    this.playVideo = function playVideo(layer, mimetype, duration, url) {

        // Video playback is currently handled on the main thread. We post a
        // message describing the request and return a no-op function. The
        // actual playback will be performed by the main thread, which may
        // temporarily replace the target layer's displayed contents with a
        // video element for the duration of playback.
        var containerId = null;
        if (layer && typeof layer.__getContainer === 'function') {
            var container = layer.__getContainer();
            if (container)
                containerId = container.__id;
        }

        return function __startWorkerVideoPlayback() {
            stage.__post({
                type: 'stage.playVideo',
                containerId: containerId,
                mimetype: mimetype,
                duration: duration,
                url: url
            });
        };

    };

};

/**
 * A worker-side compositor container. Every visible layer created within a
 * WorkerStage is given one of these containers, which mirrors the actual
 * DOM-backed container on the main thread. All compositor operations are
 * serialized to the main thread via postMessage, identified by the
 * container's unique identifier.
 *
 * @constructor
 * @augments Guacamole.Display.Stage.LayerContainer
 *
 * @param {!Guacamole.Display.WorkerStage} stage
 *     The stage that owns this container.
 *
 * @param {!number} id
 *     The unique identifier assigned to this container.
 *
 * @param {!(HTMLCanvasElement|OffscreenCanvas)} canvas
 *     The canvas wrapped by this container. Within a Worker this is always
 *     an OffscreenCanvas, because Layer uses Guacamole.Layer.createBackingCanvas
 *     which produces an OffscreenCanvas outside of a DOM context.
 *
 * @param {!number} width
 *     The initial width of this container, in pixels.
 *
 * @param {!number} height
 *     The initial height of this container, in pixels.
 */
Guacamole.Display.WorkerStage.LayerContainer = function WorkerLayerContainer(stage, id, canvas, width, height) {

    var container = this;

    /**
     * The unique identifier for this container, used to correlate messages
     * between this stage and its paired host.
     *
     * @type {!number}
     */
    this.__id = id;

    /**
     * The OffscreenCanvas backing this container. The Layer draws directly
     * into this canvas; at each frame boundary the container captures an
     * ImageBitmap from this canvas and posts it to the main thread.
     *
     * @private
     * @type {!(HTMLCanvasElement|OffscreenCanvas)}
     */
    var backingCanvas = canvas;

    /**
     * Captures the current contents of the backing canvas as an ImageBitmap
     * via createImageBitmap() and posts it to the main thread for display.
     * Returns a Promise that resolves once the bitmap message has been
     * posted (i.e. added to the channel's outgoing queue). The frame
     * sentinel in {@link Guacamole.Display.WorkerStage#onFrameFlushed}
     * uses this to ensure it is posted strictly after all bitmap
     * messages for the frame.
     *
     * @private
     * @returns {!Promise}
     */
    this.__captureAndPost = function __captureAndPost() {

        if (!backingCanvas || !backingCanvas.width || !backingCanvas.height)
            return Promise.resolve();

        if (typeof createImageBitmap !== 'function')
            return Promise.resolve();

        return createImageBitmap(backingCanvas).then(function bitmapReady(bitmap) {
            stage.__post({
                type: 'layerContainer.frame',
                containerId: id,
                bitmap: bitmap
            }, [bitmap]);
        }, function captureFailed() {
            // Swallow capture failures. The layer remains drawable on the
            // worker side; the main thread simply won't see this frame.
        });

    };

    this.getElement = function getElement() {
        return null;
    };

    this.resize = function resize(width, height) {
        stage.__post({
            type: 'layerContainer.resize',
            containerId: id,
            width: width,
            height: height
        });
    };

    this.translate = function translate(x, y) {
        stage.__post({
            type: 'layerContainer.translate',
            containerId: id,
            x: x,
            y: y
        });
    };

    this.distort = function distort(a, b, c, d, e, f) {
        stage.__post({
            type: 'layerContainer.distort',
            containerId: id,
            a: a, b: b, c: c, d: d, e: e, f: f
        });
    };

    this.attachTo = function attachTo(parent) {
        stage.__post({
            type: 'layerContainer.attachTo',
            containerId: id,
            parentContainerId: parent.__id
        });
    };

    this.setZ = function setZ(z) {
        stage.__post({
            type: 'layerContainer.setZ',
            containerId: id,
            z: z
        });
    };

    this.shade = function shade(alpha) {
        stage.__post({
            type: 'layerContainer.shade',
            containerId: id,
            alpha: alpha
        });
    };

    this.dispose = function dispose() {
        stage.__unregisterContainer(id);
        stage.__post({
            type: 'layerContainer.dispose',
            containerId: id
        });
    };

};
