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
 * Abstract video player which accepts, queues and plays back arbitrary video
 * data. It is up to implementations of this class to provide some means of
 * handling a provided Guacamole.InputStream and rendering the received data to
 * the provided Guacamole.Display.VisibleLayer. Data received along the
 * provided stream is to be played back immediately.
 *
 * @constructor
 */
Guacamole.VideoPlayer = function VideoPlayer() {

    /**
     * Notifies this Guacamole.VideoPlayer that all video up to the current
     * point in time has been given via the underlying stream, and that any
     * difference in time between queued video data and the current time can be
     * considered latency.
     */
    this.sync = function sync() {
        // Default implementation - do nothing
    };

};

/**
 * Determines whether the given mimetype is supported by any built-in
 * implementation of Guacamole.VideoPlayer, and thus will be properly handled
 * by Guacamole.VideoPlayer.getInstance().
 *
 * @param {String} mimetype
 *     The mimetype to check.
 *
 * @returns {boolean}
 *     true if the given mimetype is supported by any built-in
 *     Guacamole.VideoPlayer, false otherwise.
 */
Guacamole.VideoPlayer.isSupportedType = function isSupportedType(mimetype) {

    return Guacamole.H264VideoPlayer.isSupportedType(mimetype);

};

/**
 * Returns a list of all mimetypes supported by any built-in
 * Guacamole.VideoPlayer, in rough order of priority. Beware that only the core
 * mimetypes themselves will be listed. Any mimetype parameters, even required
 * ones, will not be included in the list.
 *
 * @returns {string[]}
 *     A list of all mimetypes supported by any built-in Guacamole.VideoPlayer,
 *     excluding any parameters.
 */
Guacamole.VideoPlayer.getSupportedTypes = function getSupportedTypes() {

    return Guacamole.H264VideoPlayer.getSupportedTypes();

};

/**
 * Returns an instance of Guacamole.VideoPlayer providing support for the given
 * video format. If support for the given video format is not available, null
 * is returned.
 *
 * @param {Guacamole.InputStream} stream
 *     The Guacamole.InputStream to read video data from.
 *
 * @param {Guacamole.Display.VisibleLayer} layer
 *     The destination layer in which this Guacamole.VideoPlayer should play
 *     the received video data.
 *
 * @param {String} mimetype
 *     The mimetype of the video data in the provided stream.
 *
 * @return {Guacamole.VideoPlayer}
 *     A Guacamole.VideoPlayer instance supporting the given mimetype and
 *     reading from the given stream, or null if support for the given mimetype
 *     is absent.
 */
Guacamole.VideoPlayer.getInstance = function getInstance(stream, layer, mimetype) {

    // Use H.264 video player if possible
    if (Guacamole.H264VideoPlayer.isSupportedType(mimetype))
        return new Guacamole.H264VideoPlayer(stream, layer);

    // No support for given mimetype
    return null;

};

/**
 * An implementation of Guacamole.VideoPlayer which plays H.264 video
 * streams using the Broadway JavaScript library.
 *
 * For Guacamole.H264VideoPlayer to be usable, the
 * Guacamole.H264VideoPlayer.BROADWAY_PLAYER_PATH property must be set to the
 * patch containing the "Player" portion of the Broadway library.
 *
 * @constructor
 * @augments Guacamole.VideoPlayer
 * @param {Guacamole.InputStream} stream
 *     The Guacamole.InputStream to read video data from.
 *
 * @param {Guacamole.Display.VisibleLayer} layer
 *     The destination layer in which this Guacamole.VideoPlayer should play
 *     the received video data.
 */
Guacamole.H264VideoPlayer = function H264VideoPlayer(stream, layer) {

    /**
     * Buffer which stores raw H.264 data, automatically parsing that data into
     * the distinct NAL units it contains.
     *
     * @private
     * @constructor
     */
    var NALBuffer = function NALBuffer() {

        /**
         * All buffers which have been added through calls to append() but have
         * not yet been read out with removeNAL().
         *
         * @private
         * @type Uint8Array[]
         */
        var buffers = [];

        /**
         * The lengths of all NAL units that have been parsed within the
         * buffers given to append(). Note that the parsing process will
         * produce a single zero length when append() is called for the first
         * time, and this length should be ignored.
         *
         * @private
         * @type Number[]
         */
        var nalLengths = [];

        /**
         * The length of the NAL unit currently being parsed.
         *
         * @private
         * @type Number
         */
        var nalLength = 0;

        /**
         * The number of contiguous zero bytes that have been read from the
         * buffers passed to append(). This value will only be non-zero after
         * a call to append() has completed if the buffer passed to that call
         * ended with a contiguous run of zero bytes.
         *
         * @private
         * @type Number
         */
        var zeroes = 0;

        /**
         * Appends the given raw H.264 data, automatically parsing the NAL
         * units within the data. The parsed NAL units may be retrieved in
         * sequence by repeatedly calling removeNAL().
         *
         * @param {ArrayBuffer} data
         *     An ArrayBuffer containing raw H.264 data. This data may contain
         *     any number of NAL units, and the last NAL unit within the data
         *     may be partial (with the remainder of that NAL unit to be
         *     supplied with future calls to append()).
         */
        this.append = function append(data) {

            // Append data to end of buffer
            var bytes = new Uint8Array(data);
            buffers.push(bytes);

            // Search unparsed region of buffer for NAL headers (0x000001 or 0x00000001)
            for (var i = 0; i < bytes.byteLength; i++) {

                // Track number of contiguous zeroes
                var value = bytes[i];
                if (value === 0x00)
                    zeroes++;

                // Once a non-zero has been hit, we may have found the last byte
                // of a NAL header
                else {

                    // Record length of previous NAL if we have found a NAL header
                    if (value === 0x01 && (zeroes === 2 || zeroes === 3)) {
                        nalLengths.push(nalLength);
                        nalLength = 0;
                    }

                    // In either case, the contiguous region of zeroes has ended
                    nalLength += zeroes + 1;
                    zeroes = 0;

                }

            }

        };

        /**
         * Returns a Uint8Array containing the next complete NAL unit in the
         * stream of H.264 data passed through repeated calls append(). If no
         * complete NAL unit is yet present, null is returned.
         *
         * @returns {Uint8Array}
         *     The next NAL unit parsed from data provided to append(), or null
         *     if no complete NAL units are presend and more data is required.
         */
        this.removeNAL = function removeNAL() {

            // Discard initial zero-length NAL
            if (nalLengths[0] === 0)
                nalLengths.shift();

            // Read next NAL length
            var nalLength = nalLengths.shift();
            if (!nalLength)
                return null;

            // Pull buffers off the buffer stack until the NAL length is
            // satisfied
            var nal = new Uint8Array(nalLength);
            while (nalLength > 0) {

                var buffer = buffers.shift();
                var offset = nal.byteLength - nalLength;

                // Append contents of buffer from stack onto the end of the
                // NAL if there is sufficient space
                if (buffer.byteLength <= nalLength) {
                    nal.set(buffer, offset);
                    nalLength -= buffer.byteLength;
                }

                // If there is insufficient space, then we've reached the end
                // of the current NAL and part of the last buffer must be put
                // back on the stack (it contains part of a future NAL)
                else {
                    nal.set(buffer.subarray(0, nalLength), offset);
                    buffers.unshift(buffer.subarray(nalLength));
                    break;
                }

            }

            return nal;

        };

    };

    /**
     * Buffer containing received H.264 data as it is gradually parsed into
     * NAL units.
     *
     * @private
     * @type NALBuffer
     */
    var nalBuffer = new NALBuffer();

    /**
     * ArrayBufferReader which provides ArrayBuffers for each blob received
     * along the given stream.
     *
     * @private
     * @type Guacamole.ArrayBufferReader
     */
    var reader = new Guacamole.ArrayBufferReader(stream);

    /**
     * An instance of the Broadway H.264 player.
     *
     * @private
     * @type Player
     */
    var player = new Player({
        useWorker : true,
        workerFile : Guacamole.H264VideoPlayer.BROADWAY_PLAYER_PATH + '/Decoder.js',
        size : {
            width  : layer.width,
            height : layer.height
        }
    });

    // Add player to DOM once first frame is rendered, continuously
    // rescaling the player to fit the layer from that point onward
    player.onRenderFrameComplete = function firstFrameRendered(params) {

        var canvas = player.canvas;

        // Init canvas style and add player to layer (if not already added)
        if (canvas.parentNode !== layer.getElement()) {

            // Player should be positioned in top-left corner
            canvas.style.position = "absolute";
            canvas.style.left = "0px";
            canvas.style.top = "0px";

            // Ensure transformations on player canvas originate at 0,0
            canvas.style.transformOrigin =
            canvas.style.webkitTransformOrigin =
            canvas.style.MozTransformOrigin =
            canvas.style.OTransformOrigin =
            canvas.style.msTransformOrigin =
                "0 0";

            layer.getElement().appendChild(canvas);

        }

        // Rescale player canvas to fit within layer dimensions, NOT
        // maintaining aspect ratio
        var xscale = layer.width / params.width;
        var yscale = layer.height / params.height;

        var canvas = player.canvas;
        canvas.style.transform =
        canvas.style.WebkitTransform =
        canvas.style.MozTransform =
        canvas.style.OTransform =
        canvas.style.msTransform =
            "scale(" + xscale + "," + yscale + ")";

    };

    // Decode all received data
    reader.ondata = function videoDataReceived(buffer) {

        // Add received data to NAL buffer
        nalBuffer.append(buffer);

        // Decode all complete NALs within the buffer (if any)
        var nal;
        while ((nal = nalBuffer.removeNAL()))
            player.decode(nal);

    };

    // Remove from layer upon completion
    reader.onend = function videoDataComplete() {
        layer.getElement().removeChild(player.canvas);
    };

};

Guacamole.H264VideoPlayer.prototype = new Guacamole.VideoPlayer();

/**
 * The path to the "Player" portion of the Broadway H264 library. This path
 * should be relative to the web application using guacamole-common-js and
 * should contain the following files: "avc.wasm", "Decoder.js", "Player.js",
 * and "YUVCanvas.js".
 *
 * @type {String}
 */
Guacamole.H264VideoPlayer.BROADWAY_PLAYER_PATH = null;

/**
 * Determines whether the given mimetype is supported by
 * Guacamole.H264VideoPlayer.
 *
 * @param {String} mimetype
 *     The mimetype to check.
 *
 * @returns {boolean}
 *     true if the given mimetype is supported by Guacamole.H264VideoPlayer,
 *     false otherwise.
 */
Guacamole.H264VideoPlayer.isSupportedType = function isSupportedType(mimetype) {

    // No supported types if Broadway is unavailable
    if (!Guacamole.H264VideoPlayer.BROADWAY_PLAYER_PATH || !window.Player)
        return false;

    return mimetype === 'video/h264';

};

/**
 * Returns a list of all mimetypes supported by Guacamole.H264VideoPlayer.
 *
 * @returns {string[]}
 *     A list of all mimetypes supported by Guacamole.H264VideoPlayer. If the
 *     Broadway H264 library is absent, this list will be empty.
 */
Guacamole.H264VideoPlayer.getSupportedTypes = function getSupportedTypes() {

    // No supported types if Broadway is unavailable
    if (!Guacamole.H264VideoPlayer.BROADWAY_PLAYER_PATH || !window.Player)
        return [];

    // We support H264 only
    return [
        'video/h264'
    ];

};
