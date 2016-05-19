/**
 * @file segment-loader.js
 */
'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});

var _createClass = (function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ('value' in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; })();

var _get = function get(_x, _x2, _x3) { var _again = true; _function: while (_again) { var object = _x, property = _x2, receiver = _x3; _again = false; if (object === null) object = Function.prototype; var desc = Object.getOwnPropertyDescriptor(object, property); if (desc === undefined) { var parent = Object.getPrototypeOf(object); if (parent === null) { return undefined; } else { _x = parent; _x2 = property; _x3 = receiver; _again = true; desc = parent = undefined; continue _function; } } else if ('value' in desc) { return desc.value; } else { var getter = desc.get; if (getter === undefined) { return undefined; } return getter.call(receiver); } } };

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

function _inherits(subClass, superClass) { if (typeof superClass !== 'function' && superClass !== null) { throw new TypeError('Super expression must either be null or a function, not ' + typeof superClass); } subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, enumerable: false, writable: true, configurable: true } }); if (superClass) Object.setPrototypeOf ? Object.setPrototypeOf(subClass, superClass) : subClass.__proto__ = superClass; }

var _ranges = require('./ranges');

var _ranges2 = _interopRequireDefault(_ranges);

var _playlist = require('./playlist');

var _videoJs = require('video.js');

var _videoJs2 = _interopRequireDefault(_videoJs);

var _sourceUpdater = require('./source-updater');

var _sourceUpdater2 = _interopRequireDefault(_sourceUpdater);

var _decrypter = require('./decrypter');

// in ms
var CHECK_BUFFER_DELAY = 500;

// the desired length of video to maintain in the buffer, in seconds
var GOAL_BUFFER_LENGTH = 30;

exports.GOAL_BUFFER_LENGTH = GOAL_BUFFER_LENGTH;
/**
 * Updates segment with information about its end-point in time and, optionally,
 * the segment duration if we have enough information to determine a segment duration
 * accurately.
 *
 * @param {Object} playlist a media playlist object
 * @param {Number} segmentIndex the index of segment we last appended
 * @param {Number} segmentEnd the known of the segment referenced by segmentIndex
 */
var updateSegmentMetadata = function updateSegmentMetadata(playlist, segmentIndex, segmentEnd) {
  if (!playlist) {
    return false;
  }

  var segment = playlist.segments[segmentIndex];
  var previousSegment = playlist.segments[segmentIndex - 1];

  if (segmentEnd && segment) {
    segment.end = segmentEnd;

    // fix up segment durations based on segment end data
    if (!previousSegment) {
      // first segment is always has a start time of 0 making its duration
      // equal to the segment end
      segment.duration = segment.end;
    } else if (previousSegment.end) {
      segment.duration = segment.end - previousSegment.end;
    }
    return true;
  }
  return false;
};

/**
 * Determines if we should call endOfStream on the media source based
 * on the state of the buffer or if appened segment was the final
 * segment in the playlist.
 *
 * @param {Object} playlist a media playlist object
 * @param {Object} mediaSource the MediaSource object
 * @param {Number} segmentIndex the index of segment we last appended
 * @param {Object} currentBuffered buffered region that currentTime resides in
 * @returns {Boolean} do we need to call endOfStream on the MediaSource
 */
var detectEndOfStream = function detectEndOfStream(playlist, mediaSource, segmentIndex, currentBuffered) {
  if (!playlist) {
    return false;
  }

  var segments = playlist.segments;

  // determine a few boolean values to help make the branch below easier
  // to read
  var appendedLastSegment = segmentIndex === segments.length - 1;
  var bufferedToEnd = currentBuffered.length && segments[segments.length - 1].end <= currentBuffered.end(0);

  // if we've buffered to the end of the video, we need to call endOfStream
  // so that MediaSources can trigger the `ended` event when it runs out of
  // buffered data instead of waiting for me
  return playlist.endList && mediaSource.readyState === 'open' && (appendedLastSegment || bufferedToEnd);
};

/*  Turns segment byterange into a string suitable for use in
 *  HTTP Range requests
 */
var byterangeStr = function byterangeStr(byterange) {
  var byterangeStart = undefined;
  var byterangeEnd = undefined;

  // `byterangeEnd` is one less than `offset + length` because the HTTP range
  // header uses inclusive ranges
  byterangeEnd = byterange.offset + byterange.length - 1;
  byterangeStart = byterange.offset;
  return 'bytes=' + byterangeStart + '-' + byterangeEnd;
};

/*  Defines headers for use in the xhr request for a particular segment.
 */
var segmentXhrHeaders = function segmentXhrHeaders(segment) {
  var headers = {};

  if ('byterange' in segment) {
    headers.Range = byterangeStr(segment.byterange);
  }
  return headers;
};

/**
 * An object that manages segment loading and appending.
 *
 * @class SegmentLoader
 * @param {Object} options required and optional options
 * @extends videojs.EventTarget
 */

var SegmentLoader = (function (_videojs$EventTarget) {
  _inherits(SegmentLoader, _videojs$EventTarget);

  function SegmentLoader(options) {
    _classCallCheck(this, SegmentLoader);

    _get(Object.getPrototypeOf(SegmentLoader.prototype), 'constructor', this).call(this);
    var settings = undefined;

    // check pre-conditions
    if (!options) {
      throw new TypeError('Initialization options are required');
    }
    if (typeof options.currentTime !== 'function') {
      throw new TypeError('No currentTime getter specified');
    }
    if (!options.mediaSource) {
      throw new TypeError('No MediaSource specified');
    }
    settings = _videoJs2['default'].mergeOptions(_videoJs2['default'].options.hls, options);

    // public properties
    this.state = 'INIT';
    this.bandwidth = settings.bandwidth;
    this.roundTrip = NaN;
    this.bytesReceived = 0;

    // private properties
    this.hasPlayed_ = settings.hasPlayed;
    this.currentTime_ = settings.currentTime;
    this.seekable_ = settings.seekable;
    this.seeking_ = settings.seeking;
    this.setCurrentTime_ = settings.setCurrentTime;
    this.mediaSource_ = settings.mediaSource;
    this.withCredentials_ = settings.withCredentials;
    this.checkBufferTimeout_ = null;
    this.error_ = void 0;
    this.expired_ = 0;
    this.timeCorrection_ = 0;
    this.currentTimeline_ = -1;
    this.xhr_ = null;
    this.pendingSegment_ = null;
    this.sourceUpdater_ = null;
    this.hls_ = settings.hls;
  }

  /**
   * dispose of the SegmentLoader and reset to the default state
   */

  _createClass(SegmentLoader, [{
    key: 'dispose',
    value: function dispose() {
      this.state = 'DISPOSED';
      this.abort_();
      if (this.sourceUpdater_) {
        this.sourceUpdater_.dispose();
      }
    }

    /**
     * abort anything that is currently doing on with the SegmentLoader
     * and reset to a default state
     */
  }, {
    key: 'abort',
    value: function abort() {
      if (this.state !== 'WAITING') {
        return;
      }

      this.abort_();

      // don't wait for buffer check timeouts to begin fetching the
      // next segment
      if (!this.paused()) {
        this.state = 'READY';
        this.fillBuffer_();
      }
    }

    /**
     * set an error on the segment loader and null out any pending segements
     *
     * @param {Error} error the error to set on the SegmentLoader
     * @return {Error} the error that was set or that is currently set
     */
  }, {
    key: 'error',
    value: function error(_error) {
      if (typeof _error !== 'undefined') {
        this.error_ = _error;
      }

      this.pendingSegment_ = null;
      return this.error_;
    }

    /**
     * load a playlist and start to fill the buffer
     */
  }, {
    key: 'load',
    value: function load() {
      this.monitorBuffer_();

      // if we don't have a playlist yet, keep waiting for one to be
      // specified
      if (!this.playlist_) {
        return;
      }

      // if we're in the middle of processing a segment already, don't
      // kick off an additional segment request
      if (!this.sourceUpdater_ || this.state !== 'READY' && this.state !== 'INIT') {
        return;
      }

      this.state = 'READY';
      this.fillBuffer_();
    }

    /**
     * set a playlist on the segment loader
     *
     * @param {PlaylistLoader} media the playlist to set on the segment loader
     */
  }, {
    key: 'playlist',
    value: function playlist(media) {
      this.playlist_ = media;
      // if we were unpaused but waiting for a playlist, start
      // buffering now
      if (this.sourceUpdater_ && media && this.state === 'INIT' && !this.paused()) {
        this.state = 'READY';
        return this.fillBuffer_();
      }
    }

    /**
     * Prevent the loader from fetching additional segments. If there
     * is a segment request outstanding, it will finish processing
     * before the loader halts. A segment loader can be unpaused by
     * calling load().
     */
  }, {
    key: 'pause',
    value: function pause() {
      if (this.checkBufferTimeout_) {
        window.clearTimeout(this.checkBufferTimeout_);

        this.checkBufferTimeout_ = null;
      }
    }

    /**
     * Returns whether the segment loader is fetching additional
     * segments when given the opportunity. This property can be
     * modified through calls to pause() and load().
     */
  }, {
    key: 'paused',
    value: function paused() {
      return this.checkBufferTimeout_ === null;
    }

    /**
     * setter for expired time on the SegmentLoader
     *
     * @param {Number} expired the exired time to set
     */
  }, {
    key: 'expired',
    value: function expired(_expired) {
      this.expired_ = _expired;
    }

    /**
     * create/set the following mimetype on the SourceBuffer through a
     * SourceUpdater
     *
     * @param {String} mimeType the mime type string to use
     */
  }, {
    key: 'mimeType',
    value: function mimeType(_mimeType) {
      // TODO Allow source buffers to be re-created with different mime-types
      if (!this.sourceUpdater_) {
        this.sourceUpdater_ = new _sourceUpdater2['default'](this.mediaSource_, _mimeType);
        this.clearBuffer();

        // if we were unpaused but waiting for a sourceUpdater, start
        // buffering now
        if (this.playlist_ && this.state === 'INIT' && !this.paused()) {
          this.state = 'READY';
          return this.fillBuffer_();
        }
      }
    }

    /**
     * asynchronously/recursively monitor the buffer
     *
     * @private
     */
  }, {
    key: 'monitorBuffer_',
    value: function monitorBuffer_() {
      if (this.state === 'READY') {
        this.fillBuffer_();
      }
      this.checkBufferTimeout_ = window.setTimeout(this.monitorBuffer_.bind(this), CHECK_BUFFER_DELAY);
    }

    /**
     * Return the amount of a segment specified by the mediaIndex overlaps
     * the current buffered content.
     *
     * @param {Object} playlist the playlist object to fetch segments from
     * @param {Number} mediaIndex the index of the segment in the playlist
     * @param {TimeRanges} buffered the state of the buffer
     * @returns {Number} percentage of the segment's time range that is
     * already in `buffered`
     */
  }, {
    key: 'getSegmentBufferedPercent_',
    value: function getSegmentBufferedPercent_(playlist, mediaIndex, currentTime, buffered) {
      var segment = playlist.segments[mediaIndex];
      var startOfSegment = (0, _playlist.duration)(playlist, playlist.mediaSequence + mediaIndex, this.expired_);
      var segmentRange = _videoJs2['default'].createTimeRanges([[Math.max(currentTime, startOfSegment), startOfSegment + segment.duration]]);

      return _ranges2['default'].calculateBufferedPercent(segmentRange, buffered);
    }

    /**
     * Determines what segment request should be made, given current
     * playback state.
     *
     * @param {TimeRanges} buffered - the state of the buffer
     * @param {Object} playlist - the playlist object to fetch segments from
     * @param {Number} currentTime - the playback position in seconds
     * @returns {Object} a segment info object that describes the
     * request that should be made or null if no request is necessary
     */
  }, {
    key: 'checkBuffer_',
    value: function checkBuffer_(buffered, playlist, currentTime) {
      var currentBuffered = _ranges2['default'].findRange(buffered, currentTime);

      // There are times when MSE reports the first segment as starting a
      // little after 0-time so add a fudge factor to try and fix those cases
      // or we end up fetching the same first segment over and over
      if (currentBuffered.length === 0 && currentTime === 0) {
        currentBuffered = _ranges2['default'].findRange(buffered, currentTime + _ranges2['default'].TIME_FUDGE_FACTOR);
      }

      var bufferedTime = undefined;
      var currentBufferedEnd = undefined;
      var timestampOffset = this.sourceUpdater_.timestampOffset();
      var segment = undefined;
      var mediaIndex = undefined;

      if (!playlist.segments.length) {
        return;
      }

      if (currentBuffered.length === 0) {
        // find the segment containing currentTime
        mediaIndex = (0, _playlist.getMediaIndexForTime_)(playlist, currentTime, this.expired_ + this.timeCorrection_);
      } else {
        // find the segment adjacent to the end of the current
        // buffered region
        currentBufferedEnd = currentBuffered.end(0);
        bufferedTime = Math.max(0, currentBufferedEnd - currentTime);

        // if the video has not yet played only, and we already have
        // one segment downloaded do nothing
        if (!this.hasPlayed_() && bufferedTime >= 1) {
          return null;
        }

        // if there is plenty of content buffered, and the video has
        // been played before relax for awhile
        if (this.hasPlayed_() && bufferedTime >= GOAL_BUFFER_LENGTH) {
          return null;
        }
        mediaIndex = (0, _playlist.getMediaIndexForTime_)(playlist, currentBufferedEnd, this.expired_ + this.timeCorrection_);
      }

      if (mediaIndex < 0 || mediaIndex === playlist.segments.length) {
        return null;
      }

      // Sanity check the segment-index determining logic above but calcuating
      // the percentage of the chosen segment that is buffered. If more than 90%
      // of the segment is buffered then fetching it will likely not help in any
      // way
      var percentBuffered = this.getSegmentBufferedPercent_(playlist, mediaIndex, currentTime, buffered);

      if (percentBuffered >= 90) {
        // Retry the buffered calculation with the next segment if there is another
        // segment after the currently selected segment
        if (mediaIndex + 1 < playlist.segments.length) {
          percentBuffered = this.getSegmentBufferedPercent_(playlist, mediaIndex + 1, currentTime, buffered);
        }

        // If both checks failed return and don't load anything
        if (percentBuffered >= 90) {
          return;
        }

        // Otherwise, continue with the next segment
        mediaIndex += 1;
      }

      segment = playlist.segments[mediaIndex];
      var startOfSegment = (0, _playlist.duration)(playlist, playlist.mediaSequence + mediaIndex, this.expired_);

      // We will need to change timestampOffset of the sourceBuffer if either of
      // the following conditions are true:
      // - The segment.timeline !== this.currentTimeline
      //   (we are crossing a discontinuity somehow)
      // - The "timestampOffset" for the start of this segment is less than
      //   the currently set timestampOffset
      if (segment.timeline !== this.currentTimeline_ || startOfSegment < this.sourceUpdater_.timestampOffset()) {
        timestampOffset = startOfSegment;
      }

      return {
        // resolve the segment URL relative to the playlist
        uri: segment.resolvedUri,
        // the segment's mediaIndex at the time it was requested
        mediaIndex: mediaIndex,
        // the segment's playlist
        playlist: playlist,
        // unencrypted bytes of the segment
        bytes: null,
        // when a key is defined for this segment, the encrypted bytes
        encryptedBytes: null,
        // the state of the buffer before a segment is appended will be
        // stored here so that the actual segment duration can be
        // determined after it has been appended
        buffered: null,
        // The target timestampOffset for this segment when we append it
        // to the source buffer
        timestampOffset: timestampOffset,
        // The timeline that the segment is in
        timeline: segment.timeline
      };
    }

    /**
     * abort all pending xhr requests and null any pending segements
     *
     * @private
     */
  }, {
    key: 'abort_',
    value: function abort_() {
      if (this.xhr_) {
        this.xhr_.abort();
      }

      // clear out the segment being processed
      this.pendingSegment_ = null;
    }

    /**
     * fill the buffer with segements unless the
     * sourceBuffers are currently updating
     *
     * @private
     */
  }, {
    key: 'fillBuffer_',
    value: function fillBuffer_() {
      if (this.sourceUpdater_.updating()) {
        return;
      }

      // see if we need to begin loading immediately
      var request = this.checkBuffer_(this.sourceUpdater_.buffered(), this.playlist_, this.currentTime_(), this.timestampOffset_);

      if (request) {
        this.loadSegment_(request);
      }
    }

    /**
     * load a specific segment from a request into the buffer
     *
     * @private
     */
  }, {
    key: 'loadSegment_',
    value: function loadSegment_(segmentInfo) {
      var segment = undefined;
      var requestTimeout = undefined;
      var keyXhr = undefined;
      var segmentXhr = undefined;
      var seekable = this.seekable_();
      var currentTime = this.currentTime_();
      var removeToTime = 0;

      // Chrome has a hard limit of 150mb of
      // buffer and a very conservative "garbage collector"
      // We manually clear out the old buffer to ensure
      // we don't trigger the QuotaExceeded error
      // on the source buffer during subsequent appends

      // If we have a seekable range use that as the limit for what can be removed safely
      // otherwise remove anything older than 1 minute before the current play head
      if (seekable.length && seekable.start(0) > 0 && seekable.start(0) < currentTime) {
        removeToTime = seekable.start(0);
      } else {
        removeToTime = currentTime - 60;
      }

      if (removeToTime > 0) {
        this.sourceUpdater_.remove(0, removeToTime);
      }

      segment = segmentInfo.playlist.segments[segmentInfo.mediaIndex];
      // Set xhr timeout to 150% of the segment duration to allow us
      // some time to switch renditions in the event of a catastrophic
      // decrease in network performance or a server issue.
      requestTimeout = segment.duration * 1.5 * 1000;

      if (segment.key) {
        keyXhr = this.hls_.xhr({
          uri: segment.key.resolvedUri,
          responseType: 'arraybuffer',
          withCredentials: this.withCredentials_,
          timeout: requestTimeout
        }, this.handleResponse_.bind(this));
      }
      this.pendingSegment_ = segmentInfo;
      var loadSegment_hook = window.videojs.hola && window.videojs.hola.loadSegment_hook;
      if (loadSegment_hook) {
        if (loadSegment_hook.call(this, keyXhr, segmentInfo)) return;
      }
      segmentXhr = this.hls_.xhr({
        uri: segmentInfo.uri,
        responseType: 'arraybuffer',
        withCredentials: this.withCredentials_,
        timeout: requestTimeout,
        headers: segmentXhrHeaders(segment)
      }, this.handleResponse_.bind(this));

      this.xhr_ = {
        keyXhr: keyXhr,
        segmentXhr: segmentXhr,
        abort: function abort() {
          if (this.segmentXhr) {
            // Prevent error handler from running.
            this.segmentXhr.onreadystatechange = null;
            this.segmentXhr.abort();
            this.segmentXhr = null;
          }
          if (this.keyXhr) {
            // Prevent error handler from running.
            this.keyXhr.onreadystatechange = null;
            this.keyXhr.abort();
            this.keyXhr = null;
          }
        }
      };

      this.state = 'WAITING';
    }

    /**
     * triggered when a segment response is received
     *
     * @private
     */
  }, {
    key: 'handleResponse_',
    value: function handleResponse_(error, request) {
      var segmentInfo = undefined;
      var segment = undefined;
      var keyXhrRequest = undefined;
      var view = undefined;

      // timeout of previously aborted request
      if (!this.xhr_ || request !== this.xhr_.segmentXhr && request !== this.xhr_.keyXhr) {
        return;
      }

      segmentInfo = this.pendingSegment_;
      segment = segmentInfo.playlist.segments[segmentInfo.mediaIndex];

      // if a request times out, reset bandwidth tracking
      if (request.timedout) {
        this.abort_();
        this.bandwidth = 1;
        this.roundTrip = NaN;
        this.state = 'READY';
        return this.trigger('progress');
      }

      // trigger an event for other errors
      if (!request.aborted && error) {
        // abort will clear xhr_
        keyXhrRequest = this.xhr_.keyXhr;
        this.abort_();
        this.error({
          status: request.status,
          message: request === keyXhrRequest ? 'HLS key request error at URL: ' + segment.key.uri : 'HLS segment request error at URL: ' + segmentInfo.uri,
          code: 2,
          xhr: request
        });
        this.state = 'READY';
        this.pause();
        return this.trigger('error');
      }

      // stop processing if the request was aborted
      if (!request.response) {
        this.abort_();
        return;
      }

      if (request === this.xhr_.segmentXhr) {
        // the segment request is no longer outstanding
        this.xhr_.segmentXhr = null;

        // calculate the download bandwidth based on segment request
        this.roundTrip = request.roundTripTime;
        this.bandwidth = request.bandwidth;
        this.bytesReceived += request.bytesReceived || 0;

        if (segment.key) {
          segmentInfo.encryptedBytes = new Uint8Array(request.response);
        } else {
          segmentInfo.bytes = new Uint8Array(request.response);
        }
      }

      if (request === this.xhr_.keyXhr) {
        keyXhrRequest = this.xhr_.segmentXhr;
        // the key request is no longer outstanding
        this.xhr_.keyXhr = null;

        if (request.response.byteLength !== 16) {
          this.abort_();
          this.error({
            status: request.status,
            message: 'Invalid HLS key at URL: ' + segment.key.uri,
            code: 2,
            xhr: request
          });
          this.state = 'READY';
          this.pause();
          return this.trigger('error');
        }

        view = new DataView(request.response);
        segment.key.bytes = new Uint32Array([view.getUint32(0), view.getUint32(4), view.getUint32(8), view.getUint32(12)]);

        // if the media sequence is greater than 2^32, the IV will be incorrect
        // assuming 10s segments, that would be about 1300 years
        segment.key.iv = segment.key.iv || new Uint32Array([0, 0, 0, segmentInfo.mediaIndex + segmentInfo.playlist.mediaSequence]);
      }

      if (!this.xhr_.segmentXhr && !this.xhr_.keyXhr) {
        this.xhr_ = null;
        this.processResponse_();
      }
    }

    /**
     * clear anything that is currently in the buffer and throw it away
     */
  }, {
    key: 'clearBuffer',
    value: function clearBuffer() {
      if (this.sourceUpdater_ && this.sourceUpdater_.buffered().length) {
        this.sourceUpdater_.remove(0, Infinity);
      }
    }

    /**
     * Decrypt the segment that is being loaded if necessary
     *
     * @private
     */
  }, {
    key: 'processResponse_',
    value: function processResponse_() {
      var segmentInfo = undefined;
      var segment = undefined;

      this.state = 'DECRYPTING';

      segmentInfo = this.pendingSegment_;
      segment = segmentInfo.playlist.segments[segmentInfo.mediaIndex];

      if (segment.key) {
        // this is an encrypted segment
        // incrementally decrypt the segment
        /* eslint-disable no-new, handle-callback-err */
        new _decrypter.Decrypter(segmentInfo.encryptedBytes, segment.key.bytes, segment.key.iv, (function (err, bytes) {
          // err always null
          segmentInfo.bytes = bytes;
          this.handleSegment_();
        }).bind(this));
        /* eslint-enable */
      } else {
          this.handleSegment_();
        }
    }

    /**
     * append a decrypted segement to the SourceBuffer through a SourceUpdater
     *
     * @private
     */
  }, {
    key: 'handleSegment_',
    value: function handleSegment_() {
      var segmentInfo = undefined;

      this.state = 'APPENDING';
      segmentInfo = this.pendingSegment_;
      segmentInfo.buffered = this.sourceUpdater_.buffered();
      this.currentTimeline_ = segmentInfo.timeline;

      if (segmentInfo.timestampOffset !== this.sourceUpdater_.timestampOffset()) {
        this.sourceUpdater_.timestampOffset(segmentInfo.timestampOffset);
      }

      this.sourceUpdater_.appendBuffer(segmentInfo.bytes, this.handleUpdateEnd_.bind(this));
    }

    /**
     * callback to run when appendBuffer is finished. detects if we are
     * in a good state to do things with the data we got, or if we need
     * to wait for more
     *
     * @private
     */
  }, {
    key: 'handleUpdateEnd_',
    value: function handleUpdateEnd_() {
      var segmentInfo = this.pendingSegment_;
      var currentTime = this.currentTime_();

      this.pendingSegment_ = null;
      // add segment timeline information if we're still using the
      // same playlist
      if (segmentInfo && segmentInfo.playlist.uri === this.playlist_.uri) {
        this.updateTimeline_(segmentInfo);
        this.trigger('progress');
      }

      var currentMediaIndex = segmentInfo.mediaIndex;

      currentMediaIndex += segmentInfo.playlist.mediaSequence - this.playlist_.mediaSequence;

      var currentBuffered = _ranges2['default'].findRange(this.sourceUpdater_.buffered(), currentTime);

      // any time an update finishes and the last segment is in the
      // buffer, end the stream. this ensures the "ended" event will
      // fire if playback reaches that point.
      var isEndOfStream = detectEndOfStream(segmentInfo.playlist, this.mediaSource_, currentMediaIndex, currentBuffered);

      if (isEndOfStream) {
        this.mediaSource_.endOfStream();
      }

      // when seeking to the beginning of the seekable range, it's
      // possible that imprecise timing information may cause the seek to
      // end up earlier than the start of the range
      // in that case, seek again
      var seekable = this.seekable_();
      var next = _ranges2['default'].findNextRange(this.sourceUpdater_.buffered(), currentTime);

      if (this.seeking_() && currentBuffered.length === 0) {
        if (seekable.length && currentTime < seekable.start(0)) {

          if (next.length) {
            _videoJs2['default'].log('tried seeking to', currentTime, 'but that was too early, retrying at', next.start(0));
            this.setCurrentTime_(next.start(0) + _ranges2['default'].TIME_FUDGE_FACTOR);
          }
        }
      }

      this.state = 'READY';

      if (!this.paused()) {
        this.fillBuffer_();
      }
    }

    /**
     * annotate the segment with any start and end time information
     * added by the media processing
     *
     * @private
     * @param {Object} segmentInfo annotate a segment with time info
     */
  }, {
    key: 'updateTimeline_',
    value: function updateTimeline_(segmentInfo) {
      var segment = undefined;
      var timelineUpdate = undefined;
      var playlist = segmentInfo.playlist;
      var currentMediaIndex = segmentInfo.mediaIndex;

      currentMediaIndex += playlist.mediaSequence - this.playlist_.mediaSequence;
      segment = playlist.segments[currentMediaIndex];

      if (!segment) {
        return;
      }

      timelineUpdate = _ranges2['default'].findSoleUncommonTimeRangesEnd(segmentInfo.buffered, this.sourceUpdater_.buffered());

      // Update segment meta-data (duration and end-point) based on timeline
      var timelineUpdated = updateSegmentMetadata(playlist, currentMediaIndex, timelineUpdate);

      // the last segment append must have been entirely in the
      // already buffered time ranges. adjust the timeCorrection
      // offset to fetch forward until we find a segment that adds
      // to the buffered time ranges and improves subsequent media
      // index calculations.
      if (!timelineUpdated) {
        this.timeCorrection_ -= segment.duration;
      } else {
        this.timeCorrection_ = 0;
      }
    }
  }]);

  return SegmentLoader;
})(_videoJs2['default'].EventTarget);

exports['default'] = SegmentLoader;