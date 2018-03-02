#!/usr/bin/env node

'use strict';

process.title = 'whitesource';

var shell = require('shelljs/global');
var cli = require('cli');
var fs = require('fs');
var mkdirp = require('mkdirp');
var checksum = require('checksum');
var yarnParser = require('@yarnpkg/lockfile');
var exec = require('child_process').exec;

var prompt = require('prompt');
prompt.message = "whitesource";
prompt.delimiter = ">".green;

var runtime = new Date().valueOf();

var constants = require('./constants');
var statusCode = require('./status_code');
var WsNodeReportBuilder = require('./ws_node_report_builder');
var WsBowerReportBuilder = require('./ws_bower_report_builder');
var WsPost = require('./ws_post');
var WsHelper = require('./ws_helper');
var version = require('./version');

var runtimeMode = "node";
var isFailOnError = false;
var isPolicyViolation = false;
var isForceUpdate = false;
var timeout = 3600000;
var isDebugMode = false;
var isFailOnConnectionError = true;
var connectionRetries = 1;
var registryAccessToken = null;

var namesOfStatusCodes = Object.keys(statusCode);

const checkPolicyField = "checkPolicies";
const forceUpdateField = "forceUpdate";
const failOnErrorField = "failOnError";
const timeoutField = "timeoutMinutes";
const debugModeField = "debugMode";
const failOnConnectionError = "failOnConnectionError";
const connectionRetriesName = "connectionRetries";
const registryAccessTokenName = "registryAccessToken";

var finish = function () {
    //TODO: rename/remove shrinkwrap file to avoid npm to use hardcoded versions.
    var timer = new Date().valueOf() - runtime;
    timer = timer / 1000;
    cli.ok('Build success!' + " ( took: " + timer + "s ) ");
    exitWithCodeMessage(statusCode.SUCCESS);
};

var buildCallback = function (isSuc, resJson, exitCode) {
    if (isSuc) {
        var fileName = (runtimeMode === "node") ? constants.NPM_RESPONSE_JSON : constants.BOWER_RESPONSE_JSON;
        if (isSuc && !(isFailOnError && isPolicyViolation)) {
            if (isDebugMode) {
                WsHelper.saveReportFile(resJson, fileName);
            }
            cli.ok(resJson);
            finish();
        } else {
            if (isFailOnError && isPolicyViolation) {
                cli.error("Some dependencies were rejected by the organization's policies");
                cli.error("Build failed!")
                exitWithCodeMessage(statusCode.POLICY_VIOLATION);
            }

            exitWithCodeMessage(exitCode);
        }
    } else {
        cli.info("Couldn't post to server");
        cli.error("Build failed!");
        exitWithCodeMessage(exitCode);
    }
};

var getRejections = function (resJson) {
    var cleanRes = WsHelper.cleanJson(resJson);
    var response = JSON.parse(cleanRes);
    try {
        var responseData = JSON.parse(response.data);
    } catch (e) {
        cli.error("Failed to find policy violations.");
        return null;
    }
    var violations = [];
    function checkRejection(child) {
        if (child.hasOwnProperty('policy') && child.policy.actionType === "Reject") {
            //cli.error("Policy violation found! Package: " + child.resource.displayName + " | Policy: " + child.policy.displayName);
            var toPush = {};
            toPush.policy = child.policy;
            delete toPush.policy.filterLogic;
            toPush.resource = child.resource;
            violations.push(toPush);
        }
        child.children.forEach(checkRejection);
    }

    function projectHasRejections(project) {
        if (project.hasOwnProperty("children")) {
            project.children.forEach(checkRejection);
        }
    }
    if (responseData.hasOwnProperty("existingProjects")) {
        var existingProjects = responseData.existingProjects;
        for (var existingProject in existingProjects) {
            // skip loop if the property is from prototype
            if (!existingProjects.hasOwnProperty(existingProject)) continue;

            var proj = existingProjects[existingProject];
            projectHasRejections(proj);
        }
    }
    if (responseData.hasOwnProperty("newProjects")) {
        var newProjects = responseData.newProjects;
        for (var newProject in newProjects) {
            // skip loop if the property is from prototype
            if (!newProjects.hasOwnProperty(newProject)) continue;

            var obj = newProjects[newProject];
            projectHasRejections(obj);
        }
    }
    return violations;
};

// new method of creating the policy rejection summary file
var getPolicyRejectionSummary = function (resJson) {
    var cleanRes = WsHelper.cleanJson(resJson);
    var response = JSON.parse(cleanRes);
    try {
        var responseData = JSON.parse(response.data);
    } catch (e) {
        cli.error("Failed to find policy violations.");
        return null;
    }

    function RejectedPolicy(policy) {
        this.policyName = policy.displayName;
        this.filterType = policy.filterType;
        this.productLevel = policy.projectLevel;
        this.inclusive = policy.inclusive;
        this.rejectedLibraries = [];
        this.equals = function (newPolicy) {
            if (this === newPolicy) {
                return true;
            }
            if (!(newPolicy instanceof RejectedPolicy)) {
                return false;
            }
            return this.policyName == newPolicy.policyName;
        }
    }

    function RejectedLibrary(resource) {
        this.name = resource.displayName;
        this.sha1 = resource.sha1;
        this.link = resource.link;
        this.project = [];
        this.equals = function (rejectedLibrary) {
            if (this === rejectedLibrary) {
                return true;
            }
            if (!(rejectedLibrary instanceof RejectedLibrary)) {
                return false;
            }
            if (this.name != null && this.name != rejectedLibrary.name) {
                return false;
            }
            if (this.sha1 != null && this.sha1 == rejectedLibrary.sha1) {
                return true;
            }
            return false;
        }
    }

    var violations = [];
    function checkRejection(child, nameOfProject) {
        if (child.hasOwnProperty('policy') && child.policy.actionType === "Reject") {
            //cli.error("Policy violation found! Package: " + child.resource.displayName + " | Policy: " + child.policy.displayName);
            if (!isPolicyExistInViolations(child.policy.displayName, child.resource, nameOfProject)) {
                var rejectedPolicy = new RejectedPolicy(child.policy);
                var rejectedLibrary = new RejectedLibrary(child.resource);
                rejectedLibrary.project.push(nameOfProject);
                rejectedPolicy.rejectedLibraries.push(rejectedLibrary);
                violations.push(rejectedPolicy);
            }
        }
        for (var i = 0; i < child.children.length; i++) {
            checkRejection(child.children[i], nameOfProject);
        }
    }

    function isPolicyExistInViolations(policyName, resource, nameOfProject) {
        for (var i = 0; i < violations.length; i++) {
            if (policyName == violations[i].policyName) {
                var library = new RejectedLibrary(resource);
                if (!isLibraryExistInPolicy(violations[i].rejectedLibraries, library, nameOfProject)) {
                    library.project.push(nameOfProject);
                    violations[i].rejectedLibraries.push(library);
                }
                return true;
            }
        }
        return false;
    }

    function isLibraryExistInPolicy(rejectedLibraries, library, nameOfProject) {
        for (var i = 0; i < rejectedLibraries.length; i++) {
            if (library.equals(rejectedLibraries[i])) {
                rejectedLibraries[i].project.push(nameOfProject);
                return true;
            }
        }
        return false;
    }

    function projectHasRejections(project, nameOfProject) {
        if (project.hasOwnProperty("children")) {
            for (var i = 0; i < project.children.length; i++) {
                checkRejection(project.children[i], nameOfProject);
            }
        }
    }
    if (responseData.hasOwnProperty("existingProjects")) {
        var existingProjects = responseData.existingProjects;
        for (var existingProject in existingProjects) {
            // skip loop if the property is from prototype
            if (!existingProjects.hasOwnProperty(existingProject)) continue;
            var proj = existingProjects[existingProject];
            projectHasRejections(proj, existingProject);
        }
    }
    if (responseData.hasOwnProperty("newProjects")) {
        var newProjects = responseData.newProjects;
        for (var newProject in newProjects) {
            // skip loop if the property is from prototype
            if (!newProjects.hasOwnProperty(newProject)) continue;
            var obj = newProjects[newProject];
            projectHasRejections(obj, newProject);
        }
    }
    return violations;
};

function exitWithCodeMessage(exitCode) {
    cli.info("Process finished with exit code " + namesOfStatusCodes[exitCode * -1] + " (" + exitCode + ")");
    process.exit(exitCode);
}

function abortUpdate(exitCode) {
    cli.info("=== UPDATE ABORTED ===");
    exitWithCodeMessage(exitCode);
}

function countTotalRejectedLibraries(violations) {
    var totalRejectedLibs = 0;
    for (var policy in violations) {
        totalRejectedLibs += violations[policy].rejectedLibraries.length;
    }
    return totalRejectedLibs;
}

var postReportToWs = function (report, confJson) {
    function checkPolicyCallback(isSuc, resJson, exitCode) {
        if (isSuc) {
            cli.info("Checking Policies");
            var violationsOldVersion = getRejections(resJson);
            var violationsNewVersion = getPolicyRejectionSummary(resJson);
            if (violationsOldVersion != null && violationsOldVersion.length == 0) {
                cli.ok("No policy violations. Posting update request");
                if (runtimeMode === "node") {
                    WsPost.postNpmJson(report, confJson, false, buildCallback, timeout, isDebugMode, connectionRetries);
                } else {
                    WsPost.postBowerJson(report, confJson, false, buildCallback, timeout, isDebugMode, connectionRetries);
                }
            } else if (violationsOldVersion == null) {
                try {
                    if (isForceUpdate) {
                        cli.info("Force updating");
                        if (runtimeMode === "node") {
                            WsPost.postNpmJson(report, confJson, false, buildCallback, timeout, isDebugMode, connectionRetries);
                        } else {
                            WsPost.postBowerJson(report, confJson, false, buildCallback, timeout, isDebugMode, connectionRetries);
                        }
                    } else if (!isFailOnError) {
                        // Not forceUpdate and not to failOnError
                        cli.ok("Ignoring policy violations.");
                        finish();
                    } else if (isFailOnError) {
                        abortUpdate(statusCode.POLICY_VIOLATION);
                    }
                } catch (e) {
                    cli.error(e);
                    abortUpdate(statusCode.ERROR);
                }
            } else {
                try {
                    isPolicyViolation = true;
                    cli.error("Some dependencies did not conform with open source policies ");
                    var nameOfViolationsOldVersionFile = "ws-log-" + constants.POLICY_VIOLATIONS;
                    var nameOfViolationsNewVersionFile = constants.POLICY_REJECTION_SUMMARY;
                    var jsonOfViolationOldVersion = JSON.stringify(violationsOldVersion, null, 4);
                    var jsonOfViolationNewVersion = JSON.stringify({ rejectingPolicies: violationsNewVersion, summary: { totalRejectedLibraries: countTotalRejectedLibraries(violationsNewVersion) } }, null, 2);
                    var writeViolationFileFunc = function (err) {
                        if (err) {
                            cli.error(err);
                            abortUpdate(statusCode.ERROR);
                        } else {
                            cli.info("review reports for details (ws-log-"
                                + constants.POLICY_VIOLATIONS + " and " + constants.POLICY_REJECTION_SUMMARY + ")");
                            if (isForceUpdate) {
                                cli.info("There are policy violations. Force updating...");
                                if (runtimeMode === "node") {
                                    WsPost.postNpmJson(report, confJson, false, buildCallback, timeout, isDebugMode, connectionRetries);
                                } else {
                                    WsPost.postBowerJson(report, confJson, false, buildCallback, timeout, isDebugMode, connectionRetries);
                                }
                            } else if (!isFailOnError) {
                                // Not forceUpdate and not to failOnError
                                cli.ok("Ignoring policy violations.");
                                finish();
                            } else if (isFailOnError) {
                                abortUpdate(statusCode.POLICY_VIOLATION);
                            }
                        }
                    }
                    fs.writeFile(nameOfViolationsOldVersionFile, jsonOfViolationOldVersion, writeViolationFileFunc);
                    fs.writeFile(nameOfViolationsNewVersionFile, jsonOfViolationNewVersion, null);
                } catch (e) {
                    cli.error(e);
                    abortUpdate(statusCode.ERROR);
                }
            }
        } else {
            if (resJson) {
                cli.error(resJson);
            }
            cli.info("Couldn't post to server");
            if (!isFailOnConnectionError) {
                cli.ok("Ignoring connection error");
                finish();
            } else {
                cli.error("Build failed!");
                exitWithCodeMessage(exitCode);
            }
        }
    }

    cli.ok('Getting ready to post report to WhiteSource...');
    var checkPolicies = confJson.hasOwnProperty(checkPolicyField) && (confJson.checkPolicies === true || confJson.checkPolicies === "true");
    if (runtimeMode === "node") {
        //WsPost.postNpmUpdateJson(report,confJson,buildCallback);
        if (checkPolicies) {
            WsPost.postNpmJson(report, confJson, true, checkPolicyCallback, timeout, isDebugMode, connectionRetries);
        } else {
            WsPost.postNpmJson(report, confJson, false, buildCallback, timeout, isDebugMode, connectionRetries);
        }
    } else {
        if (checkPolicies) {
            WsPost.postBowerJson(report, confJson, true, checkPolicyCallback, timeout, isDebugMode, connectionRetries);
        } else {
            WsPost.postBowerJson(report, confJson, false, buildCallback, timeout, isDebugMode, connectionRetries);
        }
    }
};

var deletePluginFiles = function () {
    var pathPrefix = "./" + constants.LOG_FILES_FOLDER + "/ws-log-";
    if (runtimeMode === "node") {
        fs.unlink("./" + constants.LOG_FILES_FOLDER + "/ws-" + constants.NPM_LS_JSON, unlinkCallback);
        fs.unlink(pathPrefix + constants.NPM_RESPONSE_JSON, unlinkCallback);
        fs.unlink(pathPrefix + constants.NPM_REPORT_NAME, unlinkCallback);
        fs.unlink(pathPrefix + constants.NPM_DEPS_REPORT, unlinkCallback);
        fs.unlink(pathPrefix + constants.NPM_REPORT_JSON, unlinkCallback);
        fs.unlink(pathPrefix + constants.NPM_REPORT_POST_JSON, unlinkCallback);
    } else {
        fs.unlink(pathPrefix + constants.BOWER_RESPONSE_JSON, unlinkCallback);
        fs.unlink(pathPrefix + constants.BOWER_REPORT_NAME, unlinkCallback);
        fs.unlink(pathPrefix + constants.BOWER_DEPS_REPORT, unlinkCallback);
        fs.unlink(pathPrefix + constants.BOWER_REPORT_JSON, unlinkCallback);
        fs.unlink(pathPrefix + constants.BOWER_REPORT_POST_JSON, unlinkCallback);
    }
    fs.unlink("./" + "ws-log-" + constants.POLICY_VIOLATIONS, unlinkCallback);
    fs.unlink("./" + constants.POLICY_REJECTION_SUMMARY, unlinkCallback);
    function unlinkCallback(err) { }
};

var deleteNpmLsAndFolderIfNotDebugMode = function () {
    if (!isDebugMode) {
        fs.unlink("./ws-" + constants.NPM_LS_JSON, unlinkCallback);
        fs.rmdir(constants.LOG_FILES_FOLDER, function (err) { });
    }
    function unlinkCallback(err) { };
};

var getNpmLsPath = function () {
    var path = "";
    if (isDebugMode) {
        path = "./" + constants.LOG_FILES_FOLDER + "/ws-ls.json";
    } else {
        path = "./ws-ls.json";
    }
    return path;
};

cli.setApp(constants.APP_NAME, version);
cli.enable('version');
cli.parse(null, ['bower', 'run', 'yarn']);
cli.main(function (args, options) {
    var confPath = './whitesource.config.json';
    if (options.hasOwnProperty('c') && options.c && args.length > 0) {
        confPath = args[0];
    }
    var confJson = WsHelper.initConf(confPath);
    if (!confJson) abortUpdate(statusCode.ERROR);
    isFailOnError = confJson.hasOwnProperty(failOnErrorField) && (confJson.failOnError === true || confJson.failOnError === "true");
    isForceUpdate = confJson.hasOwnProperty(forceUpdateField) && (confJson.forceUpdate === true || confJson.forceUpdate === "true");
    isDebugMode = confJson.hasOwnProperty(debugModeField) && (confJson.debugMode === true || confJson.debugMode === "true");
    if (confJson.hasOwnProperty(failOnConnectionError)) {
        isFailOnConnectionError = confJson.failOnConnectionError === true || confJson.failOnConnectionError === "true";
    }
    if (confJson.hasOwnProperty(timeoutField)) {
        timeout = confJson.timeoutMinutes * 60 * 1000;
    }
    if (confJson.hasOwnProperty(connectionRetriesName)) {
        connectionRetries = confJson.connectionRetries;
    }
    if (confJson.hasOwnProperty(registryAccessTokenName)) {
        registryAccessToken = confJson.registryAccessToken;
    }
    cli.ok('Config file is located in: ' + confPath);
    var devDepMsg = 'If you have installed Dev Dependencies and like to include them in the WhiteSource report,\n add devDep flag to the whitesource.config file to continue.'
    var missingPackageJsonMsg = 'Missing Package.json file. \n whitesource requires a valid package.json file to proceed';

    if (cli.command === "bower") {
        runtimeMode = "bower";
    }

    deletePluginFiles();

    if (isDebugMode) {
        mkdirp("./" + constants.LOG_FILES_FOLDER, function (err) {
            if (err) {
                cli.error(err);
            }
        });
    }

    // if(cli.command === "-v"){
    // 	process.stdout.write(version + '\n');
    // 	process.exit();
    // }
    if (cli.command === "run") {
        runtimeMode = "node";
        cli.ok('Running whitesource V' + version + '...');
        var hasPackageJson = WsHelper.hasFile('./package.json');
        if (!hasPackageJson) {
            cli.fatal(missingPackageJsonMsg);
        }
        var pathOfNpmLsFile = getNpmLsPath();
        var cmd = (confJson.devDep === true) ? "npm ls --json > " + pathOfNpmLsFile : "npm ls --json --only=prod > " + pathOfNpmLsFile;
        exec(cmd, function (error, stdout, stderr) {
            if (error != null) {
                deleteNpmLsAndFolderIfNotDebugMode();
                cli.error(devDepMsg);
                cli.fatal("'npm ls' command failed with the following output:\n" + error + "Make sure to run 'npm install' prior to running the plugin. Please resolve the issue and rerun the scan operation.");
            } else {
                cli.ok('Done calculation dependencies!');

                var lsResult = JSON.parse(fs.readFileSync(pathOfNpmLsFile, 'utf8'));
                WsNodeReportBuilder.traverseLsJson(lsResult, registryAccessToken)
                    .then(function (json) {
                        deleteNpmLsAndFolderIfNotDebugMode();
                        if (isDebugMode) {
                            cli.ok("Saving dependencies report");
                            WsHelper.saveReportFile(json, constants.NPM_REPORT_NAME);
                        }
                        postReportToWs(json, confJson);
                    });
            }
        });
    }

	if(cli.command === "yarn") {
        runtimeMode = "node";
        cli.ok('Running whitesource V' + version + '...');
		var hasPackageJson = WsHelper.hasFile('./package.json');
		if(!hasPackageJson) {
			cli.fatal(missingPackgeJsonMsg);
		}
		var hasYarnLock = WsHelper.hasFile('./yarn.lock');
		if(!hasYarnLock) {
			cli.fatal(missingYarnLockMsg);
		}
        var yarnData = yarnParser.parse(fs.readFileSync('./yarn.lock', 'utf8')).object;
        var pathOfNpmLsFile = getNpmLsPath();
		var cmd = (confJson.devDep === true) ? "npm ls --json > " + pathOfNpmLsFile : "npm ls --json --only=prod > " + pathOfNpmLsFile;
        exec(cmd, function(error, stdout, stderr) {
            if (error != null) {
                cli.ok('exec error: ', error);
                cli.error(devDepMsg);
                cli.fatal("'npm ls' command failed with the following output:\n" + error + "Make sure to run 'npm install' prior to running the plugin. Please resolve the issue and rerun the scan operation.");
            } else {
                cli.ok('Done calculation dependencies!');

                var lsResult = JSON.parse(fs.readFileSync(pathOfNpmLsFile, 'utf8'));
                var json = WsNodeReportBuilder.traverseYarnData(lsResult, yarnData);

                cli.ok("Saving dependencies report");
                WsHelper.saveReportFile(json, constants.NPM_REPORT_NAME);

                postReportToWs(json, confJson);
            }
        });
	}

    if (runtimeMode == "bower") {
        cli.ok('Fetching Bower Dependencies...');
        var json = WsBowerReportBuilder.buildReport();

        cli.ok("Saving bower dependencies report");

        if (isDebugMode) {
            //general project name version
            WsHelper.saveReportFile(json.report, constants.BOWER_REPORT_NAME);

            //deps report
            WsHelper.saveReportFile(json.deps, constants.BOWER_DEPS_REPORT);
        } else {
            fs.rmdir(constants.LOG_FILES_FOLDER, function (err) { });
        }

        postReportToWs(json, confJson);
    }
});
