'use strict'

var fs = require('fs')
var path = require('path')
var semver = require('semver')
var mapLimit = require('async/mapLimit')
var SourceMapConsumer = require('source-map').SourceMapConsumer
var isAbsolute = path.isAbsolute || require('path-is-absolute')

var SOURCEMAP_REGEX = /(?:\/\/[@#][ \t]+sourceMappingURL=([^\s'"]+?)[ \t]*$)|(?:\/\*[@#][ \t]+sourceMappingURL=([^*]+?)[ \t]*(?:\*\/)[ \t]*$)/
var READ_FILE_OPTS = semver.lt(process.version, '0.9.11') ? 'utf8' : {encoding: 'utf8'}
var syncCache = require('lru-cache')({max: 100})
var asyncCache = require('async-cache')({
  max: 100,
  load: loadSourcemapConsumer
})

function mapCallsiteSync (callsite) {
  if (isNode(callsite)) {
    return callsite
  }

  var filename = callsite.getFileName()
  var srcDir = path.dirname(filename)
  var consumer = syncCache.get(filename)

  if (typeof consumer === 'undefined') {
    var sourceFile = fs.readFileSync(filename, READ_FILE_OPTS)
    var sourceMapUrl = resolveSourceMapUrl(sourceFile, srcDir)

    if (!sourceMapUrl) {
      return callsite
    }

    var sourceMap = fs.readFileSync(sourceMapUrl, READ_FILE_OPTS)
    consumer = new SourceMapConsumer(sourceMap)
    syncCache.set(filename, consumer)
  }

  return extendCallsite(callsite, consumer, filename)
}

function mapCallsiteAsync (callsite, cb) {
  if (isNode(callsite)) {
    return cb(null, callsite)
  }

  var filename = callsite.getFileName()
  asyncCache.get(filename, function (err, consumer) {
    return err || !consumer
      ? cb(err, callsite)
      : cb(null, extendCallsite(callsite, consumer, filename))
  })
}

function loadSourcemapConsumer (file, cb) {
  fs.readFile(file, READ_FILE_OPTS, function (err, sourceFile) {
    if (err) {
      return cb(err)
    }

    var sourceMapUrl = resolveSourceMapUrl(sourceFile, path.dirname(file))
    if (!sourceMapUrl) {
      return cb()
    }

    fs.readFile(sourceMapUrl, READ_FILE_OPTS, function (readErr, sourceMap) {
      cb(readErr, readErr ? null : new SourceMapConsumer(sourceMap))
    })
  })
}

function isNode (callsite) {
  if (callsite.isNative()) {
    return true
  }

  var filename = callsite.getFileName() || ''
  return !isAbsolute(filename) && filename[0] !== '.'
}

function resolveSourceMapUrl (sourceFile, sourcePath) {
  var lines = sourceFile.split(/\r?\n/)
  var sourceMapUrl = null
  for (var i = lines.length - 1; i >= 0 && !sourceMapUrl; i--) {
    sourceMapUrl = lines[i].match(SOURCEMAP_REGEX)
  }

  return sourceMapUrl
    ? path.resolve(sourcePath, sourceMapUrl[1])
    : null
}

function extendCallsite (callsite, consumer, filename) {
  var info = consumer.originalPositionFor({
    line: callsite.getLineNumber(),
    column: callsite.getColumnNumber()
  })

  callsite.sourceMap = {
    getLineNumber: function () {
      return info.line
    },

    getFileName: function () {
      var srcDir = path.dirname(filename)
      return path.resolve(path.join(srcDir, info.source))
    },

    getColumnNumber: function () {
      return info.column
    }
  }

  return callsite
}

module.exports = function (callsites, cb) {
  return typeof cb === 'undefined'
    ? callsites.map(mapCallsiteSync)
    : mapLimit(callsites, 10, mapCallsiteAsync, cb)
}