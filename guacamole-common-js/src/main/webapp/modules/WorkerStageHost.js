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
 * Main-thread receiver for compositor messages originating from a
 * {@link Guacamole.Display.WorkerStage}. The host owns a main-thread
 * {@link Guacamole.Display.DOMStage} through which every DOM-related
 * operation requested by the worker is performed.
 *
 * Per visible layer, the host owns an HTMLCanvasElement that receives
 * ImageBitmap snapshots from the worker at frame boundaries. These canvases
 * are wrapped in DOMStage LayerContainers, giving them the usual CSS-based
 * compositor behavior (position, transform, opacity, z-index) that
 * {@link Guacamole.Display.VisibleLayer} relies on.
 *
 * Messages not directed at the stage (for example state-change notifications,
 * input acknowledgments, or stream events) are re-dispatched to consumers via
 * the {@link Guacamole.Display.WorkerStageHost#onmessage} callback, which
 * allows the owning facade (e.g. a {@code Guacamole.WorkerClient}) to handle
 * them.
 *
 * @constructor
 *
 * @param {!(Worker|MessagePort)} worker
 *     The worker (or MessagePort connected to one) from which compositor
 *     messages should be received. Messages will continue to be received
 *     until {@link #dispose} is called or the worker is terminated.
 *
 * @param {Guacamole.Display.DOMStage} [domStage]
 *     The main-thread DOMStage through which DOM operations should be
 *     performed. A new DOMStage is created if omitted. The stage's root
 *     element is the element that should ultimately be attached to the
 *     document to display the worker's output.
 */
Guacamole.Display.WorkerStageHost = function WorkerStageHost(worker, domStage) {

    var host = this;

    domStage = domStage || new Guacamole.Display.DOMStage();

    /**
     * Per-container state maintained on the main thread. Each visible layer
     * created by the worker is represented here by a DOMStage LayerContainer
     * (the CSS compositor wrapper), an HTMLCanvasElement onto which the
     * worker's ImageBitmaps are drawn, and the 2D context of that canvas.
     *
     * Each container also holds a single pending ImageBitmap slot. Bitmaps
     * arriving from the worker replace whatever is already pending for that
     * container (the superseded bitmap is closed to release its backing
     * buffer). Painting happens lazily, once per animation frame.
     *
     * @private
     * @type {!Object.<number, {
     *     container: !Guacamole.Display.Stage.LayerContainer,
     *     canvas: !HTMLCanvasElement,
     *     context: !CanvasRenderingContext2D,
     *     pendingBitmap: ?ImageBitmap
     * }>}
     */
    var containers = {};

    /**
     * Handle returned by the most recently-scheduled requestAnimationFrame
     * call, or null if none is outstanding. Tracked so that painting is
     * scheduled at most once per animation frame regardless of how many
     * bitmaps arrive between one vsync and the next.
     *
     * @private
     * @type {?number}
     */
    var paintRafHandle = null;

    /**
     * Schedules a painting pass for the next animation frame, if one is not
     * already scheduled.
     *
     * @private
     */
    function schedulePaint() {
        if (paintRafHandle !== null)
            return;
        paintRafHandle = requestAnimationFrame(paintPendingFrames);
    }

    /**
     * Paints the most recently-received ImageBitmap for every container
     * that has one pending, releasing the bitmap's backing resources as
     * soon as it has been drawn. No-op for containers without a pending
     * bitmap. Invoked from the animation-frame callback scheduled by
     * {@link schedulePaint}.
     *
     * @private
     */
    function paintPendingFrames() {

        paintRafHandle = null;

        for (var id in containers) {

            var entry = containers[id];
            var bitmap = entry.pendingBitmap;
            if (!bitmap)
                continue;

            // Keep the display canvas's backing resolution synchronized
            // with the incoming bitmap so that per-frame transfers draw
            // at 1:1 scale. This also covers races where a resize message
            // has not yet been processed.
            if (entry.canvas.width !== bitmap.width)
                entry.canvas.width = bitmap.width;
            if (entry.canvas.height !== bitmap.height)
                entry.canvas.height = bitmap.height;

            entry.context.clearRect(0, 0, entry.canvas.width, entry.canvas.height);
            entry.context.drawImage(bitmap, 0, 0);

            if (typeof bitmap.close === 'function')
                bitmap.close();
            entry.pendingBitmap = null;

        }

    }

    /**
     * Handler to be called when the worker posts a message that is not a
     * recognized compositor operation. The raw message object is passed
     * through unchanged so that the owning facade can dispatch
     * protocol-level events (state changes, streams, etc.) as needed.
     *
     * @event
     * @param {!Object} message
     *     The message payload as posted by the worker.
     */
    this.onmessage = null;

    /**
     * Returns the DOMStage backing this host. The stage's root element is
     * what consumers should attach to the document to display the worker's
     * output.
     *
     * @returns {!Guacamole.Display.DOMStage}
     */
    this.getDOMStage = function getDOMStage() {
        return domStage;
    };

    /**
     * Returns the outermost DOM element through which this host displays
     * content produced by the worker.
     *
     * @returns {!Element}
     */
    this.getElement = function getElement() {
        return domStage.getRootElement();
    };

    /**
     * Constructs a minimal layer-like object wrapping the given container,
     * suitable for passing to DOMStage.attachTopLevelLayer /
     * detachTopLevelLayer (which expect a VisibleLayer-shaped argument).
     *
     * @private
     * @param {!Guacamole.Display.Stage.LayerContainer} container
     */
    function layerProxyFor(container) {
        return {
            getElement: function getElement() {
                return container.getElement();
            }
        };
    }

    /**
     * Routes an incoming worker message to the appropriate compositor
     * operation or to the external onmessage callback.
     *
     * @private
     * @param {!MessageEvent} event
     */
    function handleMessage(event) {

        var message = event.data;
        if (!message || typeof message.type !== 'string') {
            if (host.onmessage)
                host.onmessage(message);
            return;
        }

        switch (message.type) {

            case 'stage.setDisplaySize':
                domStage.setDisplaySize(message.width, message.height);
                break;

            case 'stage.setBoundsSize':
                domStage.setBoundsSize(message.width, message.height);
                break;

            case 'stage.setScale':
                domStage.setScale(message.scale);
                break;

            case 'stage.attachTopLevelLayer': {
                var entry = containers[message.containerId];
                if (entry)
                    domStage.attachTopLevelLayer(layerProxyFor(entry.container));
                break;
            }

            case 'stage.detachTopLevelLayer': {
                var entry = containers[message.containerId];
                if (entry)
                    domStage.detachTopLevelLayer(layerProxyFor(entry.container));
                break;
            }

            case 'stage.createLayerContainer': {

                // Create a fresh canvas of the requested dimensions. This
                // canvas will receive per-frame ImageBitmaps from the worker
                // rather than being drawn to directly.
                var canvas = Guacamole.Layer.createBackingCanvas(
                        message.width, message.height);
                var context = canvas.getContext('2d');

                var container = domStage.createLayerContainer(
                        canvas, message.width, message.height);

                containers[message.containerId] = {
                    container: container,
                    canvas: canvas,
                    context: context,
                    pendingBitmap: null
                };
                break;
            }

            case 'layerContainer.resize': {
                var entry = containers[message.containerId];
                if (!entry)
                    break;

                // Keep the display canvas's backing resolution synchronized
                // with the layer's resolution so that per-frame bitmaps draw
                // at 1:1 scale.
                entry.canvas.width = message.width;
                entry.canvas.height = message.height;

                entry.container.resize(message.width, message.height);
                break;
            }

            case 'layerContainer.translate': {
                var entry = containers[message.containerId];
                if (entry)
                    entry.container.translate(message.x, message.y);
                break;
            }

            case 'layerContainer.distort': {
                var entry = containers[message.containerId];
                if (entry)
                    entry.container.distort(
                            message.a, message.b, message.c,
                            message.d, message.e, message.f);
                break;
            }

            case 'layerContainer.attachTo': {
                var entry = containers[message.containerId];
                var parent = containers[message.parentContainerId];
                if (entry && parent)
                    entry.container.attachTo(parent.container);
                break;
            }

            case 'layerContainer.setZ': {
                var entry = containers[message.containerId];
                if (entry)
                    entry.container.setZ(message.z);
                break;
            }

            case 'layerContainer.shade': {
                var entry = containers[message.containerId];
                if (entry)
                    entry.container.shade(message.alpha);
                break;
            }

            case 'layerContainer.dispose': {
                var entry = containers[message.containerId];
                if (entry) {
                    if (entry.pendingBitmap && typeof entry.pendingBitmap.close === 'function')
                        entry.pendingBitmap.close();
                    entry.container.dispose();
                    delete containers[message.containerId];
                }
                break;
            }

            case 'layerContainer.frame': {
                var entry = containers[message.containerId];
                var bitmap = message.bitmap;

                if (!entry || !bitmap) {
                    if (bitmap && typeof bitmap.close === 'function')
                        bitmap.close();
                    break;
                }

                // Replace any bitmap still pending for this container.
                // Only the most recent finalized frame is displayed; any
                // earlier unpainted frame is dropped to bound memory and
                // avoid wasted work.
                if (entry.pendingBitmap && typeof entry.pendingBitmap.close === 'function')
                    entry.pendingBitmap.close();
                entry.pendingBitmap = bitmap;

                schedulePaint();
                break;
            }

            case 'stage.playVideo': {
                var entry = containers[message.containerId];
                if (!entry) {
                    if (host.onmessage)
                        host.onmessage(message);
                    break;
                }

                // Minimal main-thread fallback: create an HTMLVideoElement,
                // draw each frame onto the container's main-thread display
                // canvas while the video is playing, and release the
                // element when playback ends. During playback the worker
                // may continue to post bitmaps for this container; those
                // bitmaps are drawn too, with the video's drawImage being
                // the more recent write. Any flicker is acceptable given
                // the rarity of video playback in typical Guacamole
                // workloads.
                //
                // This fallback will be replaced with a VideoDecoder-based
                // path inside the worker itself in a future iteration.
                var video = document.createElement('video');
                video.type = message.mimetype;
                video.src = message.url;

                var stopped = false;

                function renderNextVideoFrame() {
                    if (stopped)
                        return;
                    if (!video.paused && !video.ended) {
                        try {
                            entry.context.drawImage(video, 0, 0);
                        }
                        catch (e) {
                            // drawImage may throw if the video has not yet
                            // produced a frame. Ignore and try again on
                            // the next tick.
                        }
                    }
                    if (!video.ended)
                        window.setTimeout(renderNextVideoFrame, 20);
                    else
                        stopped = true;
                }

                video.addEventListener('play', renderNextVideoFrame, false);
                video.addEventListener('ended', function videoEnded() {
                    stopped = true;
                }, false);

                // Kick off playback. The play() Promise is ignored because
                // failure modes (autoplay restrictions, network errors)
                // are not actionable at this layer.
                var playResult = video.play();
                if (playResult && typeof playResult.catch === 'function')
                    playResult.catch(function ignore() {});
                break;
            }

            case 'frame':
                // Frame boundary from the worker. Surfaced to the facade
                // so that statistics/events can propagate outward.
                if (host.onmessage)
                    host.onmessage(message);
                break;

            default:
                // Any other message is passed through for the owning facade
                // to interpret.
                if (host.onmessage)
                    host.onmessage(message);
                break;

        }

    }

    // Attach the message handler to the worker
    worker.addEventListener('message', handleMessage);

    /**
     * Sends a message to the worker. This is a thin convenience wrapper
     * around the underlying postMessage, provided so that facades do not
     * need to hold a reference to the worker separately from the host.
     *
     * @param {!Object} message
     *     The message to post. Must be structured-cloneable.
     *
     * @param {Transferable[]} [transfer]
     *     Any transferable objects contained within the message.
     */
    this.postMessage = function postMessage(message, transfer) {
        if (transfer)
            worker.postMessage(message, transfer);
        else
            worker.postMessage(message);
    };

    /**
     * Detaches this host from its worker. After calling this method, no
     * further compositor messages from the worker will be processed.
     * Container state held by the host remains intact; the consumer should
     * remove the display element from the document separately if needed.
     */
    this.dispose = function dispose() {
        worker.removeEventListener('message', handleMessage);

        if (paintRafHandle !== null) {
            cancelAnimationFrame(paintRafHandle);
            paintRafHandle = null;
        }

        for (var id in containers) {
            var entry = containers[id];
            if (entry.pendingBitmap && typeof entry.pendingBitmap.close === 'function')
                entry.pendingBitmap.close();
            entry.pendingBitmap = null;
        }
    };

};
