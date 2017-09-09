/**
 * Created by Asaf on 13/07/2017.
 */
// Taken from https://github.com/bower/bower
var findup = require('findup-sync');

module.exports = require(findup('package.json', { cwd: __dirname })).version;

