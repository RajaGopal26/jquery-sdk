/*global tus:false*/

/** @license jquery.transloadit2.js: Copyright (c) 2013 Transloadit Ltd | MIT License: http://www.opensource.org/licenses/mit-license.php
 *
 * Fork this on Github: http://github.com/transloadit/jquery-sdk
 *
 * Transloadit servers allow browsers to cache jquery.transloadit2.js for 1 hour.
 * keep this in mind when rolling out fixes.
 */
require('../dep/json2')
require('../dep/jquery.jsonp')

var Assembly = require('./Assembly')
var Modal = require('./Modal')
var DragDrop = require('./DragDrop')
var FilePreview = require('./FilePreview')
var InternetConnectionChecker = require('./InternetConnectionChecker');
var I18n = require('./I18n')
var helpers = require('./helpers')
var tus = require('tus-js-client')

!(function ($) {
  var I18nDict = {
    en: {
      'errors.SERVER_CONNECTION_ERROR': 'There was a problem connecting to the upload server. Please reload your browser window and try again.',
      'errors.ASSEMBLY_NOT_FOUND': 'There was a server problem finding the proper upload. Please reload your browser window and try again.',
      'errors.INTERNET_CONNECTION_ERROR_UPLOAD_IN_PROGRESS': 'Your internet connection seems to be offline. We will automatically retry the upload until the connection works again. Please leave the browser window open.',
      'errors.INTERNET_CONNECTION_ERROR_UPLOAD_NOT_IN_PROGRESS': 'Your internet connection seems to be offline. Please leave the browser window open, so that we can retry fetching the status of your upload.',
      'errors.MAX_FILES_EXCEEDED': 'Please select at most %s files.',
      'errors.unknown': 'There was an internal error.',
      'errors.tryAgain': 'Please try your upload again.',
      'errors.troubleshootDetails': 'If you would like our help to troubleshoot this, ' +
          'please email us this information:',
      cancel: 'Cancel',
      cancelling: 'Cancelling ...',
      details: 'Details',
      startingUpload: 'Starting upload ...',
      processingFiles: 'Upload done, now processing files ...',
      uploadProgress: '%s / %s MB at %s kB/s | %s left'
    },
    ja: {
      'errors.SERVER_CONNECTION_ERROR': 'サーバー接続に問題があります',
      'errors.unknown': '通信環境に問題があります',
      'errors.tryAgain': 'しばらくしてから再度投稿してください',
      'errors.troubleshootDetails': '解決できない場合は、こちらにお問い合わせください ' +
          '下記の情報をメールでお送りください:',
      cancel: 'キャンセル',
      cancelling: 'キャンセル ...',
      details: '詳細',
      startingUpload: '投稿中 ...',
      processingFiles: '接続中',
      uploadProgress: '%s MB / %s MB (%s kB / 秒)'
    }
  }

  var OPTIONS = {
    protocol: 'https://',
    service: 'https://api2.transloadit.com/',
    assets: 'https://assets.transloadit.com/',
    beforeStart: function () { return true },
    onFileSelect: function () {},
    onStart: function () {},
    onProgress: function () {},
    onUpload: function () {},
    onResult: function () {},
    onCancel: function () {},
    onError: function () {},
    onSuccess: function () {},
    onDisconnect: function() {},
    onReconnect: function() {},
    resumable: false,
    pollInterval: 2500,
    pollTimeout: 8000,
    poll404Retries: 15,
    pollConnectionRetries: 5,
    wait: false,
    processZeroFiles: true,
    triggerUploadOnFileSelection: false,
    autoSubmit: true,
    modal: true,
    exclude: '',
    fields: false,
    params: null,
    signature: null,
    region: 'us-east-1',
    locale: 'en',
    maxNumberOfUploadedFiles: -1,
    connectionCheckInterval: 3000,
    debug: true
  }

  var CSS_LOADED = false

  $.fn.transloadit = function () {
    var args = Array.prototype.slice.call(arguments)
    var method
    var uploader
    var r

    if (this.length === 0) {
      return
    }

    if (this.length > 1) {
      this.each(function () {
        $.fn.transloadit.apply($(this), args)
      })
      return
    }

    if (args.length === 1 && typeof args[0] === 'object' || args[0] === undefined) {
      args.unshift('init')
    }

    method = args.shift()
    if (method === 'init') {
      uploader = new Uploader()
      args.unshift(this)
      this.data('transloadit.uploader', uploader)
    } else {
      uploader = this.data('transloadit.uploader')
    }

    if (!uploader) {
      throw new Error('Element is not initialized for transloadit!')
    }

    r = uploader[method].apply(uploader, args)
    return (r === undefined) ? this : r
  }

  $.fn.transloadit.i18n = I18nDict

  function Uploader () {
    this._assembly = null
    this._options = {}
    this._ended = null

    this._params = null
    this._fileCount = 0
    this._fileSizes = 0

    this._$params = null
    this._$form = null
    this._$inputs = null

    this._resumableUploads = []

    this._xhr = null
    this._dragDropObjects = []
    this._previewAreaObjects = []
    this._formData = null
    this._files = {}

    this._internetConnectionChecker = null
  }

  Uploader.prototype.init = function ($form, options) {
    var self = this
    this.options($.extend({}, OPTIONS, options || {}))

    this._initI18n()
    this._initModal()
    this._initInternetConnectionChecker()

    this._$form = $form
    this._initDragAndDrop()
    this._initFilePreview()

    this._detectFileInputs()

    this._$form.bind('submit.transloadit', function () {
      self.validate()
      self.start()
      return false
    })

    this._$inputs.on('change.transloadit', function () {
      var $input = $(this)
      self._updateInputFileSelection($input)
      self._options.onFileSelect($input.val(), $input)

      if (self._options.triggerUploadOnFileSelection) {
        self._$form.trigger('submit.transloadit')
      }
    })

    this.includeCss()
  }

  Uploader.prototype.start = function () {
    this._xhr = null
    this._ended = false
    this._fileCount = 0
    this._fileSizes = 0
    this._uploadedBytes = 0

    // Remove textareas with encoding results from previous uploads to not send them
    // as form fields.
    this._$form.find('textarea[name=transloadit]').remove()
    this._modal.reset()
    this._countAddedFilesAndSizes()

    // Simply submit the form if we should not process without files
    if (this._fileCount === 0 && !this._options.processZeroFiles) {
      if (this._options.beforeStart()) {
        this.submitForm()
      }
      return
    }

    // Run beforeStart callback before doing any heavy lifting
    if (!this._options.beforeStart()) {
      return
    }

    if (!this._checkFileCountExceeded()) {
      return
    }

    var self = this
    this._getInstance(function (err, instance) {
      if (err) {
        return
      }

      self._assembly = new Assembly({
        wait: self._options['wait'],
        instance: instance,
        protocol: self._options.protocol,
        internetConnectionChecker: self._internetConnectionChecker,
        pollTimeout: self._options.pollTimeout,
        poll404Retries: self._options.poll404Retries,
        pollConnectionRetries: self._options.pollConnectionRetries,
        pollInterval: self._options.pollInterval,

        onStart: function (assemblyResult) {
          self._options.onStart(assemblyResult)
        },
        onExecuting: function (assemblyResult) {
          // If the assembly is executing meaning all uploads are done, we will not get more progress
          // events from XHR. But if there was a connection interruption in the meantime, we want to
          // make sure all components (like the modal) now know that the error is gone.
          self._renderProgress()
        },
        onSuccess: function (assemblyResult) {
          self._ended = true
          self._options.onSuccess(assemblyResult)
          self.reset()

          if (self._options.modal) {
            self._modal.hide()
          }
          self.submitForm()
        },
        onCancel: function (assemblyResult) {
          self._ended = true
          self._options.onCancel(assemblyResult)
        },
        onError: function (assemblyObjContainingError) {
          self._errorOut(assemblyObjContainingError)
        },
        onUpload: function (upload, assemblyResult) {
          self._options.onUpload(upload, assemblyResult)
        },
        onResult: function (step, result, assemblyResult) {
          self._options.onResult(step, result, assemblyResult)
        }
      })

      var cb = function () {
        self._assembly.fetchStatus()
      }

      if (self._options.resumable && tus.isSupported) {
        self._startWithResumabilitySupport(cb)
      } else {
        self._startWithXhr(cb)
      }
    })
  }

  Uploader.prototype._getInstance = function (cb) {
    var self = this

    var url = this._options['service']
    var attempts = 0

    function attempt () {
      $.jsonp({
        url: url,
        timeout: self._options.pollTimeout,
        callbackParameter: 'callback',
        success: function (result) {
          if (result.error) {
            return self._errorOut(result)
          }

          cb(null, result.hostname)
        },
        error: function (xhr, status, jsonpErr) {
          if (!self._internetConnectionChecker.isOnline()) {
            return attempt()
          }

          var reason = 'JSONP assembly_id request status: ' + status
          reason += ', err: ' + jsonpErr

          var err = {
            error: 'SERVER_CONNECTION_ERROR',
            message: self._i18n.translate('errors.SERVER_CONNECTION_ERROR'),
            reason: reason,
            url: url
          }
          self._errorOut(err)
          cb(err)
        }
      })
    }

    attempt()

    if (this._options.modal) {
      this._modal.show()
    }
  }

  Uploader.prototype._startWithXhr = function (cb) {
    var self = this
    this._formData = this._prepareFormData()

    this._appendFilteredFormFields()
    this._appendCustomFormData()
    this._appendFiles()

    this._xhr = new XMLHttpRequest()

    this._xhr.addEventListener("error", function(err) {
      self._xhr = null
    })
    this._xhr.addEventListener("abort", function(err) {
      self._xhr = null
    })
    this._xhr.addEventListener("timeout", function(err) {
      self._xhr = null
    })
    this._xhr.addEventListener("load", function() {
      self._xhr = null
    })

    this._xhr.upload.addEventListener("progress", function progressFunction(evt){
      if (!evt.lengthComputable) {
        return
      }

      self._renderProgress(evt.loaded, evt.total)
      self._options.onProgress(evt.loaded, evt.total, self._assemblyResult)
    })

    var url = this._assembly.getRequestTargetUrl(true)
    this._xhr.open('POST', url)
    this._xhr.send(this._formData)
    cb()
  }

  Uploader.prototype._startWithResumabilitySupport = function (cb) {
    var self = this
    this._formData = this._prepareFormData()
    this._formData.append('tus_num_expected_upload_files', this._fileCount)

    this._appendFilteredFormFields()
    this._appendCustomFormData()

    // We need this to control retries/resumes
    this._xhr = true

    function proceed () {
      // adding uploads from drag/dropped files and input fields
      for (var name in self._files) {
        for (var i = 0; i < self._files[name].length; i++) {
          var file = self._files[name][i]
          var upload = self._addResumableUpload(name, file)
          upload.start()
        }
      }
    }

    var f = new XMLHttpRequest()
    var url = this._assembly.getRequestTargetUrl()
    f.open('POST', url)
    f.onreadystatechange = function () {
      if (f.readyState === 4 && f.status === 200) {
        var resp = JSON.parse(f.responseText)
        self._assembly.setId(resp.id)
        self._assembly.setUrl(resp.status_endpoint)
        proceed()
        cb()
      }
    }
    f.send(this._formData)
  }

  Uploader.prototype._addResumableUpload = function (nameAttr, file) {
    var self = this
    // We need to force HTTPS in this case, because - only if the website is on
    // plain HTTP - the response to the CORS preflight request, will contain a
    // redirect to a HTTPS url. However, redirects are not allowed a responses
    // to preflight requests and causes the tus upload creation to fail.
    var endpoint = this._options.protocol + this._assembly.getInstance() + '/resumable/files/'

    // Store the last value of bytesUploaded of the progress event from tus
    // for calculating the number of all bytes uploaded accross all uploads
    var lastBytesUploaded = 0

    var upload = new tus.Upload(file, {
      endpoint: endpoint,
      // Setting resume to false, may seem a bit counterproductive but you need
      // to keep the actual effects of this setting in mind:
      //   a boolean indicating whether the client should attempt to resume the
      //   upload if the upload has been started in the past. This includes
      //   storing the file's fingerprint. Use false to force an entire reupload.
      // Right now, always want to upload the entire file for two reasons:
      // 1. Transloadit is not able to use the file uploaded from assembly A
      //    in assembly B, so we need to transfer the file for each assembly
      //    again and,
      // 2. there is no mechanism for resuming the uploading for an assembly if
      //    the Uploader object gets destroyed (for example, if the page is
      //    reloaded) so we do not know to which assembly a file belongs and
      //    more.
      resume: false,
      metadata: {
        fieldname: nameAttr,
        filename: file.name,
        assembly_url: this._assembly.getUrl()
      },
      fingerprint: function(file) {
        // Fingerprinting is not necessary any more since we have disabled
        // the resuming of previous uploads.
        throw new Error("fingerprinting should not happend")
      },
      onError: function (error) {
        self._xhr = false
        self._errorOut(error)
      },
      onSuccess: function() {
        self._xhr = false
      },
      onProgress: function (bytesUploaded, bytesTotal) {
        // Calculate the number of uploaded bytes of all uploads by removing
        // the last known value and then adding the new value.
        self._uploadedBytes = self._uploadedBytes - lastBytesUploaded + bytesUploaded
        lastBytesUploaded = bytesUploaded

        self._renderProgress(self._uploadedBytes, self._fileSizes)
        self._options.onProgress(self._uploadedBytes, self._fileSizes, self._assemblyResult)
      }
    })

    this._resumableUploads.push(upload)
    return upload
  }

  Uploader.prototype._prepareFormData = function () {
    var assemblyParams = this._options.params
    if (this._$params) {
      assemblyParams = this._$params.val()
    }
    if (typeof assemblyParams !== 'string') {
      assemblyParams = JSON.stringify(assemblyParams)
    }

    var result = {}
    if (this._options.formData instanceof FormData) {
      result = this._options.formData
    } else {
      result = new FormData()
    }

    result.append('params', assemblyParams)
    if (this._options.signature) {
      result.append('signature', this._options.signature)
    }

    return result
  }

  Uploader.prototype._appendFiles = function () {
    for (var key in this._files) {
      for (var i = 0; i < this._files[key].length; i++) {
        this._formData.append(key, this._files[key][i])
        this._fileCount++
        this._fileSizes += this._files[key][i].size
      }
    }
  }

  Uploader.prototype._updateInputFileSelection = function ($input) {
    var files = $input[0].files
    var name = $input.attr('name')
    if (!name) {
      return
    }

    // Remove old selection from preview areas if possible
    if (name in this._files) {
      var oldFiles = this._files[name]
      for (var i = 0; i < oldFiles.length; i++) {
        this._removeFileFromPreviewAreas(oldFiles[i])
      }
    }

    if (files.length === 0) {
      delete this._files[name]
    } else {
      if (!(name in this._files)) {
        this._files[name] = []
      }

      // Add new selection to preview areas
      for (var i = 0; i < files.length; i++) {
        var file = files[i]
        this._files[name].push(file)
        this._addFileToPreviewAreas(file)
      }
    }
  }

  Uploader.prototype._countAddedFilesAndSizes = function () {
    this._fileCount = 0
    this._fileSizes = 0

    for (var key in this._files) {
      for (var i = 0; i < this._files[key].length; i++) {
        this._fileCount++
        this._fileSizes += this._files[key][i].size
      }
    }
  }

  Uploader.prototype._appendFilteredFormFields = function () {
    var $fields = this._getFilteredFormFields()
    var self = this

    $fields.each(function () {
      var name = $(this).attr('name')
      if (!name) {
        return
      }

      if (!this.files) { // Files are added via appendFiles
        self._formData.append(name, $(this).val())
      }
    })
  }

  Uploader.prototype._checkFileCountExceeded = function () {
    if (this._options.maxNumberOfUploadedFiles == -1) {
      return true
    }

    if (this._fileCount > this._options.maxNumberOfUploadedFiles) {
      var max = this._options.maxNumberOfUploadedFiles
      var err = {
        error: 'MAX_FILES_EXCEEDED',
        message: this._i18n.translate('errors.MAX_FILES_EXCEEDED', max)
      }
      this._errorOut(err)
      return false
    }

    return true
  }

  Uploader.prototype._appendCustomFormData = function () {
    if (!this._options.formData) {
      return
    }

    for (var i = 0; i < this._options.formData.length; i++) {
      var tupel = this._options.formData[i]
      this._formData.append(tupel[0], tupel[1], tupel[2])
    }
  }

  Uploader.prototype._getFilteredFormFields = function () {
    var fieldsFilter = '[name=params], [name=signature]'
    if (this._options.fields === true) {
      fieldsFilter = '*'
    } else if (typeof this._options.fields === 'string') {
      fieldsFilter += ', ' + this._options.fields
    }

    // Filter out submit elements right away as they will cause funny behavior
    // in the shadow form.
    var $fields = this._$form.find(':input[type!=submit]')

    // Do not fetch file input fields as we handle uploads over this._files
    $fields = $fields.filter('[type!=file]')

    return $fields.filter(fieldsFilter)
  }

  Uploader.prototype.stop = function () {
    if (this._assembly) {
      this._assembly.stopStatusFetching()
    }
    this._ended = true
  }

  Uploader.prototype.reset = function () {
    this._files = {}
    this._resumableUploads = []
    this._fileCount = 0
    this._fileSizes = 0

    for (var i = 0; i < this._previewAreaObjects.length; i++) {
      this._previewAreaObjects[i].removeAllFiles()
    }
  }

  Uploader.prototype.unbindEvents = function () {
    this._$form.unbind('submit.transloadit')
    this._$inputs.unbind('change.transloadit')
  }

  Uploader.prototype.destroy = function () {
    this.stop()
    this.reset()
    this.unbindEvents()
    this._$form.data('transloadit.uploader', null)
  }

  Uploader.prototype.cancel = function () {
    this._formData = this._prepareFormData()
    this._abortUpload()
    this.reset()

    var self = this
    function hideModal () {
      if (self._options.modal) {
        self._modal.hide()
      }
    }

    if (this._ended) {
      return hideModal()
    }

    if (this._$params) {
      this._$params.prependTo(this._$form)
    }

    this._assembly.stopStatusFetching()
    this._modal.renderCancelling()
    this._assembly.cancel(hideModal)
  }

  Uploader.prototype.submitForm = function () {
    // prevent that files are uploaded to the final destination
    // after all that is what we use this plugin for :)
    if (this._$form.attr('enctype') === 'multipart/form-data') {
      this._$form.removeAttr('enctype')
    }

    if (this._assemblyResult !== null) {
      $('<textarea/>')
        .attr('name', 'transloadit')
        .text(JSON.stringify(this._assemblyResult))
        .prependTo(this._$form).hide()
    }

    if (this._options.autoSubmit) {
      this._$form.unbind('submit.transloadit').submit()
    }
  }

  Uploader.prototype.validate = function () {
    if (!this._options.params) {
      var $params = this._$form.find('input[name=params]')
      if (!$params.length) {
        alert('Could not find input[name=params] in your form.')
        return
      }

      this._$params = $params
      try {
        this._params = JSON.parse($params.val())
      } catch (e) {
        alert('Error: input[name=params] seems to contain invalid JSON.')
        return
      }
    } else {
      this._params = this._options.params
    }

    var fileInputFieldsAreGood = true
    this._$inputs.each(function() {
      var name = $(this).attr('name')
      if (!name) {
        fileInputFieldsAreGood = false
      }
    })
    if (!fileInputFieldsAreGood) {
      alert('Error: One of your file input fields does not contain a name attribute!')
    }

    if (this._params.redirect_url) {
      this._$form.attr('action', this._params.redirect_url)
    } else if (this._options.autoSubmit && (this._$form.attr('action') === this._options.service + 'assemblies')) {
      alert('Error: input[name=params] does not include a redirect_url')
      return
    }
  }

  Uploader.prototype._renderError = function (err) {
    if (!this._options.modal) {
      return
    }

    if (!this._options.debug) {
      return this.cancel()
    }

    err.assemblyId = this._assembly.getId()
    err.instance = this._assembly.getInstance()
    this._modal.renderError(err)
  }

  Uploader.prototype._detectFileInputs = function () {
    var $inputs = this._$form
      .find('input[type=file]')
      .not(this._options.exclude)

    if (!this._options['processZeroFiles']) {
      $inputs = $inputs.filter(function () {
        return this.value !== ''
      })
    }
    this._$inputs = $inputs
  }

  Uploader.prototype._renderProgress = function (received, expected) {
    if (!this._options.modal) {
      return
    }
    this._modal.renderProgress(received, expected)
  }

  Uploader.prototype.includeCss = function () {
    if (CSS_LOADED || !this._options.modal) {
      return
    }

    CSS_LOADED = true
    $('<link rel="stylesheet" type="text/css" href="' + this._options.assets + 'css/transloadit3-latest.css" />')
      .appendTo('head')
  }

  Uploader.prototype._errorOut = function (err) {
    if (!err.message) {
      err.message = this._i18n.translate('errors.' + err.error)
    }

    this._ended = true
    this._renderError(err)
    this._options.onError(err)
    this._abortUpload()
  }

  Uploader.prototype._abortUpload = function () {
    if (this._xhr && typeof this._xhr.abort === "function") {
      this._xhr.abort()
    }

    for (var i = 0; i < this._resumableUploads.length; i++) {
      var upload = this._resumableUploads[i]
      upload.abort()
    }
  }

  Uploader.prototype._initI18n = function () {
    this._i18n = new I18n(I18nDict, this._locale)
  }

  Uploader.prototype._initModal = function () {
    var self = this
    this._modal = new Modal({
      onClose: function() {
        self.cancel()
      },
      i18n: this._i18n
    })
  }

  Uploader.prototype._initDragAndDrop = function () {
    var $dropAreas = this._$form.find('.transloadit-drop-area')
    if ($dropAreas.length === 0) {
      return
    }

    var self = this
    var i = 0
    $dropAreas.each(function () {
      var name = $(this).data('name') || 'files'

      self._dragDropObjects[i] = new DragDrop({
        onFileAdd: function (file) {
          if (self._files[name]) {
            self._files[name].push(file)
          } else {
            self._files[name] = [file]
          }

          if (self._options.triggerUploadOnFileSelection) {
            self._$form.trigger('submit.transloadit')
          }
          self._options.onFileSelect(file, $(this))
          self._addFileToPreviewAreas(file)
        },
        $el: $(this)
      })
      i++
    })
  }

  Uploader.prototype._initFilePreview = function () {
    var $previewAreas = this._$form.find('.transloadit-file-preview-area')
    if ($previewAreas.length === 0) {
      return
    }

    var self = this
    var i = 0
    $previewAreas.each(function () {
      var name = $(this).data('name') || 'files'

      self._previewAreaObjects[i] = new FilePreview({
        onFileRemove: function (file) {
          self._removeFileFromFormData(file)
          self._removeFileFromPreviewAreas(file)
        },
        $el: $(this)
      })
      i++
    })
  }

  Uploader.prototype._addFileToPreviewAreas = function (file) {
    for (var i = 0; i < this._previewAreaObjects.length; i++) {
      this._previewAreaObjects[i].addFile(file)
    }
  }

  Uploader.prototype._removeFileFromPreviewAreas = function (file) {
    for (var i = 0; i < this._previewAreaObjects.length; i++) {
      this._previewAreaObjects[i].removeFile(file)
    }
  }

  Uploader.prototype._removeFileFromFormData = function (file) {
    for (var i = 0; i < this._previewAreaObjects.length; i++) {
      this._previewAreaObjects[i].removeFile(file)
    }

    for (var key in this._files) {
      for (var i = 0; i < this._files[key].length; i++) {
        var myFile = this._files[key][i]
        if (myFile.size !== file.size || myFile.name !== file.name) {
          continue
        }

        if (myFile.lastModified !== file.lastModified) {
          continue
        }

        this._files[key].splice(i, 1);
      }
    }
  }

  Uploader.prototype._initInternetConnectionChecker = function () {
    var self = this

    this._internetConnectionChecker = new InternetConnectionChecker({
      intervalLength: this._options.connectionCheckInterval,
      onDisconnect: function () {
        var errorType = 'INTERNET_CONNECTION_ERROR_UPLOAD_IN_PROGRESS'

        if (!this._xhr) {
          errorType = 'INTERNET_CONNECTION_ERROR_UPLOAD_NOT_IN_PROGRESS'
        }

        var err = {
          error: errorType,
          message: self._i18n.translate('errors.' + errorType)
        }
        self._renderError(err)

        self._options.onDisconnect()
      },
      onReconnect: function () {
        // If no upload is in progress anyway, then we do not need to do anything here.
        // Polling for the assembly status will auto-continue without us doing anything here.
        if (!self._xhr) {
          return
        }

        if (!self._options.resumable) {
          // Note: Google Chrome can resume xhr requests. However, we ignore this here, because
          // we have our own resume flag with tus support.
          self._abortUpload()

          // If we have an upload in progress when we get the disconnect, retry it.
          // If we do not have an upload in progress, we keep polling automatically for the status.
          // No need to take further action here for this case.
          return self.start()
        }

        // Resuming of uploads is done automatically for us in the tus client

        self._options.onReconnect()
      }
    })
    this._internetConnectionChecker.start()
  }

  Uploader.prototype.options = function (options) {
    if (arguments.length === 0) {
      return this._options
    }

    $.extend(this._options, options)
  }

  Uploader.prototype.option = function (key, val) {
    if (arguments.length === 1) {
      return this._options[key]
    }

    this._options[key] = val
  }
}(window.jQuery))
