/**
 * @license MIT
 */

import FlowFile from './FlowFile';
import {each, async, arrayRemove, extend, webAPIFileRead} from './tools';

/**
 * Flow.js is a library providing multiple simultaneous, stable and
 * resumable uploads via the HTML5 File API.
 * @param [opts]
 * @param {number|Function} [opts.chunkSize]
 * @param {bool} [opts.forceChunkSize]
 * @param {number} [opts.simultaneousUploads]
 * @param {bool} [opts.singleFile]
 * @param {string} [opts.fileParameterName]
 * @param {number} [opts.progressCallbacksInterval]
 * @param {number} [opts.speedSmoothingFactor]
 * @param {Object|Function} [opts.query]
 * @param {Object|Function} [opts.headers]
 * @param {bool} [opts.withCredentials]
 * @param {Function} [opts.preprocess]
 * @param {string} [opts.method]
 * @param {string|Function} [opts.testMethod]
 * @param {string|Function} [opts.uploadMethod]
 * @param {bool} [opts.prioritizeFirstAndLastChunk]
 * @param {bool} [opts.allowDuplicateUploads]
 * @param {string|Function} [opts.target]
 * @param {number} [opts.maxChunkRetries]
 * @param {number} [opts.chunkRetryInterval]
 * @param {Array.<number>} [opts.permanentErrors]
 * @param {Array.<number>} [opts.successStatuses]
 * @param {Function} [opts.initFileFn]
 * @param {Function} [opts.readFileFn]
 * @param {Function} [opts.generateUniqueIdentifier]
 * @constructor
 */
export default class Flow {

  constructor(opts) {
    /**
     * Library version
     * @type {string}
     */
    Flow.version = '<%= version %>';

    /**
     * Check if directory upload is supported
     * @type {boolean}
     */
    this.supportDirectory = (
      /Chrome/.test(window.navigator.userAgent) ||
      /Firefox/.test(window.navigator.userAgent) ||
      /Edge/.test(window.navigator.userAgent)
    );

    /**
     * List of FlowFile objects
     * @type {Array.<FlowFile>}
     */
    this.files = [];

    /**
     * Default options for flow.js
     * @type {Object}
     */
    this.defaults = {
      chunkSize: 1024 * 1024,
      forceChunkSize: false,
      simultaneousUploads: 3,
      singleFile: false,
      fileParameterName: 'file',
      progressCallbacksInterval: 500,
      speedSmoothingFactor: 0.1,
      query: {},
      headers: {},
      withCredentials: false,
      preprocess: null,
      changeRawDataBeforeSend: null,
      method: 'multipart',
      testMethod: 'GET',
      uploadMethod: 'POST',
      prioritizeFirstAndLastChunk: false,
      allowDuplicateUploads: false,
      target: '/',
      testChunks: true,
      generateUniqueIdentifier: null,
      maxChunkRetries: 0,
      chunkRetryInterval: null,
      permanentErrors: [404, 413, 415, 500, 501],
      successStatuses: [200, 201, 202],
      onDropStopPropagation: false,
      initFileFn: null,
      readFileFn: webAPIFileRead
    };

    /**
     * Current options
     * @type {Object}
     */
    this.opts = {};

    /**
     * List of events:
     *  key stands for event name
     *  value array list of callbacks
     * @type {}
     */
    this.events = {};

    /**
     * Current options
     * @type {Object}
     */
    this.opts = extend({}, this.defaults, opts || {});

    // A workaround for using this.method.bind(this) as a (removable) event handler.
    // https://stackoverflow.com/questions/11565471
    this._onDropBound = null;
  }

  /**
   * On drop event
   * @function
   * @param {MouseEvent} event
   */
  onDrop(event) {
    if (this.opts.onDropStopPropagation) {
      event.stopPropagation();
    }
    event.preventDefault();
    var dataTransfer = event.dataTransfer;
    if (dataTransfer.items && dataTransfer.items[0] &&
        dataTransfer.items[0].webkitGetAsEntry) {
      this.webkitReadDataTransfer(event);
    } else {
      this.addFiles(dataTransfer.files, event);
    }
  }

  /**
   * Prevent default
   * @function
   * @param {MouseEvent} event
   */
  preventEvent(event) {
    event.preventDefault();
  }

  /**
   * Set a callback for an event, possible events:
   * fileSuccess(file), fileProgress(file), fileAdded(file, event),
   * fileRemoved(file), fileRetry(file), fileError(file, message),
   * complete(), progress(), error(message, file), pause()
   * @function
   * @param {string} event
   * @param {Function} callback
   */
  on(event, callback) {
    event = event.toLowerCase();
    if (!this.events.hasOwnProperty(event)) {
      this.events[event] = [];
    }
    this.events[event].push(callback);
  }

  /**
   * Remove event callback
   * @function
   * @param {string} [event] removes all events if not specified
   * @param {Function} [fn] removes all callbacks of event if not specified
   */
  off(event, fn) {
    if (event !== undefined) {
      event = event.toLowerCase();
      if (fn !== undefined) {
        if (this.events.hasOwnProperty(event)) {
          arrayRemove(this.events[event], fn);
        }
      } else {
        delete this.events[event];
      }
    } else {
      this.events = {};
    }
  }

  /**
   * Fire an event
   * @function
   * @param {string} event event name
   * @param {...} args arguments of a callback
   * @return {bool} value is false if at least one of the event handlers which handled this event
   * returned false. Otherwise it returns true.
   */
  fire(event, args) {
    // `arguments` is an object, not array, in FF, so:
    args = Array.prototype.slice.call(arguments);
    event = event.toLowerCase();
    var preventDefault = false;
    if (this.events.hasOwnProperty(event)) {
      each(this.events[event], function (callback) {
        preventDefault = callback.apply(this, args.slice(1)) === false || preventDefault;
      }, this);
    }
    if (event != 'catchall') {
      args.unshift('catchAll');
      preventDefault = this.fire.apply(this, args) === false || preventDefault;
    }
    return !preventDefault;
  }

  /**
   * Read webkit dataTransfer object
   * @param event
   */
  webkitReadDataTransfer(event) {
    var queue = event.dataTransfer.items.length;
    var decrement = () => {
      if (--queue == 0) {
        this.addFiles(files, event);
      }
    };

    var files = [];
    for (let item of event.dataTransfer.items) {
      var entry = item.webkitGetAsEntry();
      if (!entry) {
        decrement();
        return ;
      }
      if (entry.isFile) {
        // due to a bug in Chrome's File System API impl - #149735
        fileReadSuccess(item.getAsFile(), entry.fullPath);
      } else {
        readDirectory(entry.createReader());
      }
    }

    function readDirectory(reader) {
      reader.readEntries((entries) => {
        if (entries.length) {
          queue += entries.length;
          for (let entry of entries) {
            if (entry.isFile) {
              var fullPath = entry.fullPath;
              entry.file((file) => fileReadSuccess(file, fullPath), readError);
            } else if (entry.isDirectory) {
              readDirectory(entry.createReader());
            }
          }
          readDirectory(reader);
        } else {
          decrement();
        }
      }, readError);
    }
    function fileReadSuccess(file, fullPath) {
      // relative path should not start with "/"
      file.relativePath = fullPath.substring(1);
      files.push(file);
      decrement();
    }
    function readError(fileError) {
      decrement();
      throw fileError;
    }
  }

  /**
   * Generate unique identifier for a file
   * @function
   * @param {FlowFile} file
   * @returns {string}
   */
  generateUniqueIdentifier(file) {
    var custom = this.opts.generateUniqueIdentifier;
    if (typeof custom === 'function') {
      return custom(file);
    }
    // Some confusion in different versions of Firefox
    var relativePath = file.relativePath || file.webkitRelativePath || file.fileName || file.name;
    return file.size + '-' + relativePath.replace(/[^0-9a-zA-Z_-]/img, '');
  }

  /**
   * Upload next chunk from the queue
   * @function
   * @returns {boolean}
   * @private
   */
  uploadNextChunk(preventEvents) {
    // In some cases (such as videos) it's really handy to upload the first
    // and last chunk of a file quickly; this let's the server check the file's
    // metadata and determine if there's even a point in continuing.
    var found = false;
    if (this.opts.prioritizeFirstAndLastChunk) {
      each(this.files, function (file) {
        if (!file.paused && file.chunks.length &&
            file.chunks[0].status() === 'pending') {
          file.chunks[0].send();
          found = true;
          return false;
        }
        if (!file.paused && file.chunks.length > 1 &&
            file.chunks[file.chunks.length - 1].status() === 'pending') {
          file.chunks[file.chunks.length - 1].send();
          found = true;
          return false;
        }
      });
      if (found) {
        return found;
      }
    }

    // Now, simply look for the next, best thing to upload
    each(this.files, function (file) {
      if (!file.paused) {
        each(file.chunks, function (chunk) {
          if (chunk.status() === 'pending') {
            chunk.send();
            found = true;
            return false;
          }
        });
      }
      if (found) {
        return false;
      }
    });
    if (found) {
      return true;
    }

    // The are no more outstanding chunks to upload, check is everything is done
    var outstanding = false;
    each(this.files, function (file) {
      if (!file.isComplete()) {
        outstanding = true;
        return false;
      }
    });
    if (!outstanding && !preventEvents) {
      // All chunks have been uploaded, complete
      async(function () {
        this.fire('complete');
      }, this);
    }
    return false;
  }


  /**
   * Assign a browse action to one or more DOM nodes.
   * @function
   * @param {Element|Array.<Element>} domNodes
   * @param {boolean} isDirectory Pass in true to allow directories to
   * @param {boolean} singleFile prevent multi file upload
   * @param {Object} attributes set custom attributes:
   *  http://www.w3.org/TR/html-markup/input.file.html#input.file-attributes
   *  eg: accept: 'image/*'
   * be selected (Chrome only).
   */
  assignBrowse(domNodes, isDirectory, singleFile, attributes) {
    if (domNodes instanceof Element) {
      domNodes = [domNodes];
    }

    each(domNodes, function (domNode) {
      var input;
      if (domNode.tagName === 'INPUT' && domNode.type === 'file') {
        input = domNode;
      } else {
        input = document.createElement('input');
        input.setAttribute('type', 'file');
        // display:none - not working in opera 12
        extend(input.style, {
          visibility: 'hidden',
          position: 'absolute',
          width: '1px',
          height: '1px'
        });
        // for opera 12 browser, input must be assigned to a document
        domNode.appendChild(input);
        // https://developer.mozilla.org/en/using_files_from_web_applications)
        // event listener is executed two times
        // first one - original mouse click event
        // second - input.click(), input is inside domNode
        domNode.addEventListener('click', function() {
          input.click();
        }, false);
      }
      if (!this.opts.singleFile && !singleFile) {
        input.setAttribute('multiple', 'multiple');
      }
      if (isDirectory) {
        input.setAttribute('webkitdirectory', 'webkitdirectory');
      }
      each(attributes, function (value, key) {
        input.setAttribute(key, value);
      });
      // When new files are added, simply append them to the overall list
      input.addEventListener('change', (e) => {
        if (e.target.value) {
          this.addFiles(e.target.files, e);
          e.target.value = '';
        }
      }, false);
    }, this);
  }

  /**
   * Assign one or more DOM nodes as a drop target.
   * @function
   * @param {Element|Array.<Element>} domNodes
   */
  assignDrop(domNodes) {
    if (typeof domNodes.length === 'undefined') {
      domNodes = [domNodes];
    }

    this._onDropBound = this.onDrop.bind(this);
    for (let domNode of domNodes) {
      domNode.addEventListener('dragover', this.preventEvent, false);
      domNode.addEventListener('dragenter', this.preventEvent, false);
      domNode.addEventListener('drop', this._onDropBound, false);
    }
  }

  /**
   * Un-assign drop event from DOM nodes
   * @function
   * @param domNodes
   */
  unAssignDrop(domNodes) {
    if (typeof domNodes.length === 'undefined') {
      domNodes = [domNodes];
    }

    for (let domNode of domNodes) {
      domNode.removeEventListener('dragover', this.preventEvent, false);
      domNode.removeEventListener('dragenter', this.preventEvent, false);
      domNode.removeEventListener('drop', this._onDropBound, false);
    }
  }

  /**
   * Returns a boolean indicating whether or not the instance is currently
   * uploading anything.
   * @function
   * @returns {boolean}
   */
  isUploading() {
    var uploading = false;
    each(this.files, function (file) {
      if (file.isUploading()) {
        uploading = true;
        return false;
      }
    });
    return uploading;
  }

  /**
   * should upload next chunk
   * @function
   * @returns {boolean|number}
   */
  _shouldUploadNext() {
    var num = 0;
    var should = true;
    var simultaneousUploads = this.opts.simultaneousUploads;
    each(this.files, function (file) {
      each(file.chunks, function(chunk) {
        if (chunk.status() === 'uploading') {
          num++;
          if (num >= simultaneousUploads) {
            should = false;
            return false;
          }
        }
      });
    });
    // if should is true then return uploading chunks's length
    return should && num;
  }

  /**
   * Start or resume uploading.
   * @function
   */
  upload() {
    // Make sure we don't start too many uploads at once
    var ret = this._shouldUploadNext();
    if (ret === false) {
      return;
    }
    // Kick off the queue
    this.fire('uploadStart');
    var started = false;
    for (var num = 1; num <= this.opts.simultaneousUploads - ret; num++) {
      started = this.uploadNextChunk(true) || started;
    }
    if (!started) {
      async(function () {
        this.fire('complete');
      }, this);
    }
  }

  /**
   * Resume uploading.
   * @function
   */
  resume() {
    each(this.files, function (file) {
      if (!file.isComplete()) {
        file.resume();
      }
    });
  }

  /**
   * Pause uploading.
   * @function
   */
  pause() {
    each(this.files, function (file) {
      file.pause();
    });
  }

  /**
   * Cancel upload of all FlowFile objects and remove them from the list.
   * @function
   */
  cancel() {
    for (var i = this.files.length - 1; i >= 0; i--) {
      this.files[i].cancel();
    }
  }

  /**
   * Returns a number between 0 and 1 indicating the current upload progress
   * of all files.
   * @function
   * @returns {number}
   */
  progress() {
    var totalDone = 0;
    var totalSize = 0;
    // Resume all chunks currently being uploaded
    each(this.files, function (file) {
      totalDone += file.progress() * file.size;
      totalSize += file.size;
    });
    return totalSize > 0 ? totalDone / totalSize : 0;
  }

  /**
   * Add a HTML5 File object to the list of files.
   * @function
   * @param {File} file
   * @param {Event} [event] event is optional
   */
  addFile(file, event) {
    this.addFiles([file], event);
  }

  /**
   * Add a HTML5 File object to the list of files.
   * @function
   * @param {FileList|Array} fileList
   * @param {Event} [event] event is optional
   */
  addFiles(fileList, event) {
    var files = [];
    // ie10+
    var ie10plus = window.navigator.msPointerEnabled;

    each(fileList, function (file) {
      // https://github.com/flowjs/flow.js/issues/55
      if ((!ie10plus || ie10plus && file.size > 0) && !(file.size % 4096 === 0 && (file.name === '.' || file.fileName === '.'))) {
        var uniqueIdentifier = this.generateUniqueIdentifier(file);
        if (this.opts.allowDuplicateUploads || !this.getFromUniqueIdentifier(uniqueIdentifier)) {
          var f = new FlowFile(this, file, uniqueIdentifier);
          if (this.fire('fileAdded', f, event)) {
            files.push(f);
          }
        }
      }
    }, this);
    if (this.fire('filesAdded', files, event)) {
      each(files, function (file) {
        if (this.opts.singleFile && this.files.length > 0) {
          this.removeFile(this.files[0]);
        }
        this.files.push(file);
      }, this);
      this.fire('filesSubmitted', files, event);
    }
  }


  /**
   * Cancel upload of a specific FlowFile object from the list.
   * @function
   * @param {FlowFile} file
   */
  removeFile(file) {
    for (var i = this.files.length - 1; i >= 0; i--) {
      if (this.files[i] === file) {
        this.files.splice(i, 1);
        file.abort();
        this.fire('fileRemoved', file);
      }
    }
  }

  /**
   * Look up a FlowFile object by its unique identifier.
   * @function
   * @param {string} uniqueIdentifier
   * @returns {boolean|FlowFile} false if file was not found
   */
  getFromUniqueIdentifier(uniqueIdentifier) {
    var ret = false;
    each(this.files, function (file) {
      if (file.uniqueIdentifier === uniqueIdentifier) {
        ret = file;
      }
    });
    return ret;
  }

  /**
   * Returns the total size of all files in bytes.
   * @function
   * @returns {number}
   */
  getSize() {
    var totalSize = 0;
    each(this.files, function (file) {
      totalSize += file.size;
    });
    return totalSize;
  }

  /**
   * Returns the total size uploaded of all files in bytes.
   * @function
   * @returns {number}
   */
  sizeUploaded() {
    var size = 0;
    each(this.files, function (file) {
      size += file.sizeUploaded();
    });
    return size;
  }

  /**
   * Returns remaining time to upload all files in seconds. Accuracy is based on average speed.
   * If speed is zero, time remaining will be equal to positive infinity `Number.POSITIVE_INFINITY`
   * @function
   * @returns {number}
   */
  timeRemaining() {
    var sizeDelta = 0;
    var averageSpeed = 0;
    each(this.files, function (file) {
      if (!file.paused && !file.error) {
        sizeDelta += file.size - file.sizeUploaded();
        averageSpeed += file.averageSpeed;
      }
    });
    if (sizeDelta && !averageSpeed) {
      return Number.POSITIVE_INFINITY;
    }
    if (!sizeDelta && !averageSpeed) {
      return 0;
    }
    return Math.floor(sizeDelta / averageSpeed);
  }
};
