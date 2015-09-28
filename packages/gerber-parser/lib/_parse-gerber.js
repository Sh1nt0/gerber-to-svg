// parse gerber function
// takes a parser transform stream and a block string
'use strict'

var map = require('lodash.map')

var commands = require('./_commands')
var normalize = require('./normalize-coord')
var parseCoord = require('./parse-coord')
var parseMacroBlock = require('./_parse-macro-block')

// g-code set matchers
var reMODE = /^G0*([123])/
var reREGION = /^G3([67])/
var reARC = /^G7([45])/
var reBKP_UNITS = /^G7([01])/
var reCOMMENT = /^G0*4/

// tool changes
var reTOOL = /^(?:G54)?D0*([1-9]\d+)/

// operations
var reCOORD = /((?:[XYIJ][+-]?\d+){1,4})/
var reOP = /D0*([123])$/

// parameter code matchers
var reUNITS = /^%MO(IN|MM)/
// format spec regexp courtesy @summivox
var reFORMAT = /^%FS([LT]?)([AI]?)X([0-7])([0-7])Y\3\4/
var rePOLARITY = /^%LP([CD])/
var reSTEP_REP = /^%SR(?:X(\d+)Y(\d+)I([\d.]+)J([\d.]+))?/
var reTOOL_DEF = /^%ADD(\d{2,})([A-Za-z_]\w*)(?:,((?:X?[\d.]+)*))?/
var reMACRO = /^%AM([A-Za-z_]\w*)\*?(.*)/

var parseToolDef = function(parser, block) {
  var format = {places: parser.format.places}
  var toolMatch = block.match(reTOOL_DEF)
  var tool = toolMatch[1]
  var shapeMatch = toolMatch[2]
  var toolArgs = (toolMatch[3]) ? toolMatch[3].split('X') : []

  // get the shape
  var shape
  var maxArgs
  if (shapeMatch === 'C') {
    shape = 'circle'
    maxArgs = 3
  }
  else if (shapeMatch === 'R') {
    shape = 'rect'
    maxArgs = 4
  }
  else if (shapeMatch === 'O') {
    shape = 'obround'
    maxArgs = 4
  }
  else if (shapeMatch === 'P') {
    shape = 'poly'
    maxArgs = 5
  }
  else {
    shape = shapeMatch
    maxArgs = 0
  }

  var val
  if (shape === 'circle') {
    val = [normalize(toolArgs[0], format)]
  }
  else if (shape === 'rect' || shape === 'obround') {
    val = [normalize(toolArgs[0], format), normalize(toolArgs[1], format)]
  }
  else if (shape === 'poly') {
    val = [normalize(toolArgs[0], format), Number(toolArgs[1]), 0]
    if (toolArgs[2]) {
      val[2] = Number(toolArgs[2])
    }
  }
  else {
    val = map(toolArgs, Number)
  }

  var hole = []
  if (toolArgs[maxArgs - 1]) {
    hole = [
      normalize(toolArgs[maxArgs - 2], format),
      normalize(toolArgs[maxArgs - 1], format)
    ]
  }
  else if (toolArgs[maxArgs - 2]) {
    hole = [normalize(toolArgs[maxArgs - 2], format)]
  }
  var toolDef = {shape: shape, val: val, hole: hole}
  return parser._push(commands.tool(tool, toolDef))
}

var parseMacroDef = function(parser, block) {
  var macroMatch = block.match(reMACRO)
  var name = macroMatch[1]
  var blockMatch = (macroMatch[2].length) ? macroMatch[2].split('*') : []
  var blocks = map(blockMatch, parseMacroBlock, parser)

  return parser._push(commands.macro(name, blocks))
}

var parse = function(parser, block) {
  if (reCOMMENT.test(block)) {
    return
  }

  if (block === 'M02') {
    return parser._push(commands.done())
  }

  if (reREGION.test(block)) {
    var regionMatch = block.match(reREGION)[1]
    var region = (regionMatch === '6') ? true : false
    return parser._push(commands.set('region', region))
  }

  if (reARC.test(block)) {
    var arcMatch = block.match(reARC)[1]
    var arc = (arcMatch === '4') ? 's' : 'm'
    return parser._push(commands.set('arc', arc))
  }

  if (reUNITS.test(block)) {
    var unitsMatch = block.match(reUNITS)[1]
    var units = (unitsMatch === 'IN') ? 'in' : 'mm'
    return parser._push(commands.set('units', units))
  }

  if (reBKP_UNITS.test(block)) {
    var bkpUnitsMatch = block.match(reBKP_UNITS)[1]
    var backupUnits = (bkpUnitsMatch === '0') ? 'in' : 'mm'
    return parser._push(commands.set('backupUnits', backupUnits))
  }

  if (reFORMAT.test(block)) {
    var formatMatch = block.match(reFORMAT)
    var zero = formatMatch[1]
    var nota = formatMatch[2]
    var leading = Number(formatMatch[3])
    var trailing = Number(formatMatch[4])
    var format = parser.format

    format.zero = format.zero || zero
    if (!format.places.length) {
      format.places = [leading, trailing]
    }

    // warn if zero suppression missing or set to trailing
    if (!format.zero) {
      format.zero = 'L'
      parser._warn('zero suppression missing from format; assuming leading')
    }
    else if (format.zero === 'T') {
      parser._warn('trailing zero suppression has been deprecated')
    }

    var epsilon = 1.5 * Math.pow(10, -parser.format.places[1])
    parser._push(commands.set('nota', nota))
    parser._push(commands.set('epsilon', epsilon))
    return
  }

  if (rePOLARITY.test(block)) {
    var polarity = block.match(rePOLARITY)[1]
    return parser._push(commands.level('polarity', polarity))
  }

  if (reSTEP_REP.test(block)) {
    var stepRepeatMatch = block.match(reSTEP_REP)
    var x = stepRepeatMatch[1] || 1
    var y = stepRepeatMatch[2] || 1
    var i = stepRepeatMatch[3] || 0
    var j = stepRepeatMatch[4] || 0
    var sr = {x: Number(x), y: Number(y), i: Number(i), j: Number(j)}
    return parser._push(commands.level('stepRep', sr))
  }

  if (reTOOL.test(block)) {
    var tool = block.match(reTOOL)[1]
    return parser._push(commands.set('tool', tool))
  }

  if (reTOOL_DEF.test(block)) {
    return parseToolDef(parser, block)
  }

  if (reMACRO.test(block)) {
    return parseMacroDef(parser, block)
  }

  // finally, look for mode commands and operations
  // they may appear in the same block
  var coordMatch = block.match(reCOORD)
  var opMatch = block.match(reOP)
  var modeMatch = block.match(reMODE)

  if (opMatch || coordMatch || modeMatch) {
    if (modeMatch) {
      var mode
      if (modeMatch[1] === '1') {
        mode = 'i'
      }
      else if (modeMatch[1] === '2') {
        mode = 'cw'
      }
      else {
        mode = 'ccw'
      }
      parser._push(commands.set('mode', mode))
    }

    if (opMatch || coordMatch) {
      var opCode = (opMatch) ? opMatch[1] : ''
      var coordString = (coordMatch) ? coordMatch[1] : ''
      var coord = parseCoord(coordString, parser.format)

      var op = 'last'
      if (opCode === '1') {
        op = 'int'
      }
      else if (opCode === '2') {
        op = 'move'
      }
      else if (opCode === '3') {
        op = 'flash'
      }

      parser._push(commands.op(op, coord))
    }

    return
  }

  // if we reach here the block was unhandled, so warn if it is not empty
  return parser._warn('block "' + block + '" was not recognized and was ignored')
}

module.exports = parse
