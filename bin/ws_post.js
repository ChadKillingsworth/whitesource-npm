var cli = require('cli');
var fs = require('fs');
var globalTunnel = require('global-tunnel');
var request = require('request');


var pluginVersion = require('./version');
var WsHelper = require('./ws_helper');
var constants = require('./constants');
var StatusCode = require('./status_code');
var colon = ":";

var WsPost = exports;
exports.constructor = function WsPost() {
};

var defaultBaseURL = 'saas.whitesourcesoftware.com';

WsPost.getPostOptions = function (confJson, report, isBower) {

    //TODO: make this better - if this is bower then report is an object.report node.
    if (isBower) {
        var report = report.report;
    }

    var useHttps = true;

    if (typeof(confJson.https) !== "undefined") {
        useHttps = confJson.https;
    }

    var options = {
        isHttps: useHttps,
        protocol: ( (useHttps) ? "https://" : "http://"),
        checkPol: ((confJson.checkPolicies === true || confJson.checkPolicies === "true") ? confJson.checkPolicies : false),
        forceCheckAllDependencies: ((confJson.checkPolicies == true && confJson.forceCheckAllDependencies) ? confJson.forceCheckAllDependencies : false),
        myReqType: 'UPDATE',
        reqHost: ( (confJson.baseURL) ? confJson.baseURL : defaultBaseURL),
        port: ( (confJson.port) ? confJson.port : "443"),
        productName: ( (confJson.productName) ? confJson.productName : ((confJson.productToken) ? confJson.productToken : "")),
        productVer: ( (confJson.productVer) ? confJson.productVer : report.version),
        productToken: ( (confJson.productToken) ? confJson.productToken : "" ),
        projectName: ( (confJson.projectName) ? confJson.projectName : ((confJson.projectToken) ? "" : report.name) ),
        projectVer: ( (confJson.projectVer) ? confJson.projectVer : report.version ),
        projectToken: ( (confJson.projectToken) ? confJson.projectToken : "" ),
        apiKey: confJson.apiKey || process.env.WHITESOURCE_API_KEY,
        ts: new Date().valueOf()
    };

    options.postURL = (options.protocol + options.reqHost + colon + options.port + "/agent");

    //add proxy if set.
    var proxy = confJson.proxy;
    if (proxy) {
        process.env.http_proxy = proxy;
        process.env.https_proxy = proxy;
        cli.ok('Using proxy: ' + proxy);
    }

    return options;
};

WsPost.postBowerJson = function (report, confJson, isCheckPolicies, postCallback, timeout, isDebugMode, connectionRetries) {
    cli.ok('Getting ready to post -bower- report to WhiteSource...');
    var reqOpt = WsPost.getPostOptions(confJson, report, true);

    if (isCheckPolicies) {
        reqOpt.myReqType = "CHECK_POLICY_COMPLIANCE";
    }

    if (!reqOpt.apiKey) {
        cli.error('Cant find API Key, please make sure you input your whitesource API token in the whitesource.config file or as an environment variable WHITESOURCE_API_KEY');
        return false
    }

    if (reqOpt.projectToken && reqOpt.productToken) {
        cli.error('Cant use both project Token & product Token please select use only one token,to fix this open the whitesource.config file and remove one of the tokens.');
        return false
    }

    var myRequest = WsPost.buildRequest(report, reqOpt, "bower-plugin", null, confJson);
    // If both Project-Token and ProductToken send the Project-Token
    if (reqOpt.projectToken) {
        myRequest.myPost.projectToken = reqOpt.projectToken;
    } else if (reqOpt.productToken) {
        myRequest.myPost.productToken = reqOpt.productToken;
    }

    if (isDebugMode) {
        WsHelper.saveReportFile(myRequest.json, constants.BOWER_REPORT_JSON);
        WsHelper.saveReportFile(myRequest.myPost, constants.BOWER_REPORT_POST_JSON);
    }

    postRequest(reqOpt.postURL, postCallback, isCheckPolicies, myRequest.myPost, timeout, connectionRetries);
};

WsPost.postNpmJson = function (report, confJson, isCheckPolicies, postCallback, timeout, isDebugMode, connectionRetries) {
    var reqOpt = WsPost.getPostOptions(confJson, report);

    if (isCheckPolicies) {
        reqOpt.myReqType = "CHECK_POLICY_COMPLIANCE";
    }

    try {
        var modJson = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
        if (typeof (modJson.version) == "undefined") {
            modJson.version = "0.00";
        }
    } catch (e) {
        cli.error('Problem reading Package.json, please check the file is a valid JSON');
        return false;
    }

    if (!modJson.name || !modJson.version) {
        cli.error('Node package -Name- and -Version- must be specified in module Package.json file');
        return false;
    }

    if (!reqOpt.apiKey) {
        //console.log(confJson.apiKey)
        cli.error('Cant find API Key, please make sure you input your whitesource API token in the whitesource.config file or as an environment variable WHITESOURCE_API_KEY');
        return false
    }

    if (reqOpt.projectToken && reqOpt.productToken) {
        cli.error('Cant use both project Token & product Token please select use only one token,to fix this open the whitesource.config file and remove one of the tokens.');
        return false
    }

    var myRequest = WsPost.buildRequest(report, reqOpt, "npm-plugin", modJson, confJson);

    //if both Project-Token and ProductToken send the Project-Token
    if (reqOpt.projectToken) {
        myRequest.myPost.projectToken = reqOpt.projectToken;
    } else if (reqOpt.productToken) {
        myRequest.myPost.productToken = reqOpt.productToken;
    }

    if (isDebugMode) {
        WsHelper.saveReportFile(myRequest.json, constants.NPM_REPORT_JSON);
        WsHelper.saveReportFile(myRequest.myPost, constants.NPM_REPORT_POST_JSON);
    }

    postRequest(reqOpt.postURL, postCallback, isCheckPolicies, myRequest.myPost, timeout, connectionRetries);
};

WsPost.buildRequest = function (report, reqOpt, agent, modJson, confJson) {

    //TODO: make this better - if this is bower then report is an object.report node.
    var dependencies = (modJson) ? report.children : report.deps;
    var name = (modJson) ? modJson.name : report.report.name;
    var version = (modJson) ? modJson.version : report.report.version;

    if (confJson.projectName) {
        name = confJson.projectName;
    }


    var json = [{
        dependencies: dependencies
    }];

    if (reqOpt.projectToken) {
        json[0].projectToken = reqOpt.projectToken
    } else {
        json[0].coordinates = {
            "artifactId": name,
            "version": version
        }
    }

    var myPost = {
        'type': reqOpt.myReqType,
        'agent': agent,
        'agentVersion': '1.0',
        'pluginVersion': pluginVersion,
        'forceCheckAllDependencies': reqOpt.forceCheckAllDependencies,
        'product': reqOpt.productName,
        'productVersion': reqOpt.productVer,
        'token': reqOpt.apiKey,
        'timeStamp': reqOpt.ts,
        'diff': JSON.stringify(json)
    };

    return {myPost: myPost, json: json};
};


function postRequest(postUrl, postCallback, isCheckPolicies, postBody, timeout, connectionRetries) {
    cli.ok((isCheckPolicies ? "Check Policies: " : "Update: ") + "Posting to :" + postUrl);

    request.post(postUrl, {timeout: timeout}, function optionalCallback(err, httpResponse, body) {
        if (err && connectionRetries < 1) {
            if (postCallback) {
                postCallback(false, err, StatusCode.CONNECTION_FAILURE);
            } else {
                console.error('upload failed:', err);
                console.error(JSON.stringify(httpResponse));
                console.error(JSON.stringify(body));
            }
        } else if (err && connectionRetries >= 1) {
            cli.error(err);
            cli.info("Attempting to reconnect to WhiteSource");
            setTimeout(postRequest, constants.DEFAULT_CONNECTION_DELAY_TIME_MILLISECONDS, postUrl, postCallback, isCheckPolicies, postBody, timeout, connectionRetries - 1);
        } else {
            if ((httpResponse.statusCode == 301 || httpResponse.statusCode == 302 || httpResponse.statusCode == 307) && httpResponse.headers.location) {
                postRequest(httpResponse.headers.location, postCallback, isCheckPolicies, postBody, timeout, connectionRetries);
            } else if (httpResponse.statusCode >= 400) {
                cli.error("Http request failed with status code: " + httpResponse.statusCode + ". Message: " + httpResponse.statusMessage);
                if (connectionRetries >= 1) {
                    cli.info("Attempting to reconnect to WhiteSource");
                    setTimeout(postRequest, constants.DEFAULT_CONNECTION_DELAY_TIME_MILLISECONDS, postUrl, postCallback, isCheckPolicies, postBody, timeout, connectionRetries - 1);
                } else {
                    postCallback(false, err, StatusCode.SERVER_FAILURE);
                }
            } else {
                cli.ok("Code: " + httpResponse.statusCode + " Message: " + httpResponse.statusMessage);
                postCallback(true, body, null);
            }
        }
    }).form(postBody);
}