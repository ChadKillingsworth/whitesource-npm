var traverse = require('traverse');
var cli = require('cli');
var fs = require('fs');
var glob = require("glob");

var packageJson = "package.json";
var nodeModules = "node_modules";
var WsNodeReportBuilder = exports;
exports.constructor = function WsNodeReportBuilder(){};

WsNodeReportBuilder.refitNodes = function(obj){
	var build, key, destKey, ix, value;
    var mapShortToLong = {
        "dependencies": "children",
        "resolved" : "artifactId"
    };

    build = {};
    for (key in obj) {

        // Get the destination key
        destKey = mapShortToLong[key] || key;

        // Get the value
        value = obj[key];

        // If this is an object, recurse
        if (typeof value === "object") {
            value = WsNodeReportBuilder.refitNodes(value);
        }

        // Set it on the result using the destination key
        build[destKey] = value;
        if(destKey === "children"){
        	build[destKey] = [];
        	for (var i in value){
        		build[destKey].push(value[i]);
        		value[i].name = i;
        		value[i].groupId = i;
        		value[i].systemPath = null;
        		value[i].scope = null;;
        		value[i].exclusions = [];
				value[i].classifier = null;
        	}
        }
    }
    return build;
};


function replaceScopedDependencies(objPointer) {
	var baseIndex = 0;
	var count = (objPointer.match(/@/g) || []).length;
	for	(var i = 0; i < count; i++) {
		var atIndex = objPointer.indexOf("@",baseIndex);
		var bracketsIndex = objPointer.indexOf("][", atIndex);
		objPointer = objPointer.substring(0,bracketsIndex - 1) + "/" + objPointer.substring(bracketsIndex + 3);
		baseIndex = bracketsIndex;
	}
	return objPointer;
}

function getPackageJsonPath(uri) {
	var originalUri = uri;
	while (!fs.existsSync(uri) && uri != packageJson) {
		var count = (uri.match(/\//g) || []).length;
		if (count > 3) {
			var nodeIndex = uri.lastIndexOf("/node_modules/");
			if (nodeIndex > -1) {
				var endingPath = uri.substring(nodeIndex + 13);
				var tempPath = uri.substring(0, nodeIndex);
				var lastSlash = tempPath.lastIndexOf("/");
				var basePath = tempPath.substring(0, lastSlash);
				var possibleAtIndex = basePath.lastIndexOf("/");
				if (basePath.charAt(possibleAtIndex + 1) == "@") {
					basePath = basePath.substring(0, possibleAtIndex);
				}
				uri = basePath + endingPath;
			}
		} else {
			uri = originalUri;
			while (!fs.existsSync(uri) && uri != packageJson) {
				uri = uri.substring(uri.indexOf("/") + 1);
				if (uri.startsWith("@")) {
					uri = uri.substring(uri.indexOf("/") + 1);
				}
				uri = uri.substring(uri.indexOf("/") + 1);
			}
		}
	}
	if (uri === packageJson) {
		uri = originalUri;
		var midPackages = uri.split(/node_modules/g);
		for (var i = 1; i < midPackages.length - 1; i++) {
			uri = nodeModules + midPackages[i] + nodeModules + midPackages[midPackages.length - 1];
			if (uri != packageJson && fs.existsSync(uri)) {
				return uri;
			}
		}
		uri = packageJson;
	}

	return uri;
}
WsNodeReportBuilder.traverseLsJson = function(allDependencies){
	cli.ok("Building dependencies report");
	var foundedShasum = 0;
	var missingShasum = 0;
	var invalidDeps = [];
	var parseData = allDependencies;
	var scrubbed = traverse(parseData).paths();

	// Create "endsWith" function for node version 0.10.x and earlier.
	String.prototype.endsWith = String.prototype.endsWith || function(str){
			return new RegExp(str + "$").test(str);
	};

	var getParentDepPointer = function(depPointer){
		//Example :  "[dependencies"]["ft-next-express"]["dependencies"]["@financial-times"]["n-handlebars"]"

		//["n-handlebars"]"
		var childDepStr = depPointer.substr(depPointer.lastIndexOf('['),depPointer.lastIndexOf(']') );

		//"n-handlebars"
		var childDepName = JSON.parse( childDepStr )[0]; 

		//"[dependencies"]["ft-next-express"]["dependencies"]["@financial-times"]"
		var ansStr = depPointer.substr(0,depPointer.lastIndexOf('['));

		//"[dependencies"]["ft-next-express"]["dependencies"]["@financial-times"
		var transStr = ansStr.substring(0,ansStr.lastIndexOf('"]'));
		
		//"[dependencies"]["ft-next-express"]["dependencies"]["@financial-times" + / + child + "]";
		fixedStr = transStr + "/" + childDepName + '"]';
		return fixedStr;

	};

	for (var i = 0; i<scrubbed.length; i++){
		var path = scrubbed[i];
		for(var j = 0; j<path.length; j++){
			var isDep =  (path[j] === "dependencies");
			var isVer = (path[j] === "version");
			var isResolved = (path[j] === "resolved");
			var isFrom = (path[j] === "from");
			var isName = (path[j] === "name");
			var isShasum = ((path[j] === "shasum" ) || (path[j] === "_shasum")); //shasum can be "_shasum"
		//	var isShasum = (path[j] === "shasum"); //shasum can be "_shasum"
			var isNodeMod = (path[j] === "node_modules");
			if(isDep){
				path[j] = "node_modules";
				isNodeMod = true;
			}

			var SLASH = "/";
			var fullUri = scrubbed[i].join(SLASH) + SLASH + packageJson;
			var isValidPath = true;
			if ((fullUri.endsWith("/dev/" + packageJson) && !fullUri.endsWith("node_modules/dev/" + packageJson)) ||
				(fullUri.endsWith("/optional/" + packageJson) && !fullUri.endsWith("node_modules/optional/" + packageJson))) {
				isValidPath = false;
			}

	        if(path[j] === path[path.length -1] && j === (path.length - 1)
	        	 && !isName && !isNodeMod && !isFrom
	        	 && !isResolved && !isVer && !isShasum && isValidPath){

		        	var pointerStrng = scrubbed[i].join('.').replace(/node_modules/gi, "dependencies");

		        	//console.log('scanning for shasum at path: ' + fullUri )
		        	var strArr = fullUri.split("");
		        	for(var k = 0; k<strArr.length; k++){
					   if(strArr[k] == SLASH){
					    strArr[k] = '"]["';
					   }
					}

					var dataObjPointer;
					var joinedStr = strArr.join('');
					joinedStr = joinedStr.substr(0,joinedStr.lastIndexOf('['));
					var objPointer = 'parseData["' + joinedStr.replace(/node_modules/gi, "dependencies");
					objPointer = replaceScopedDependencies(objPointer);

					var invalidProj = false;
					try{
						dataObjPointer = eval(objPointer);
					}catch(e){
						invalidProj = true;
					}
					try {
						var uri = fullUri;
						var badPackage = false;
						uri = getPackageJsonPath(uri);
						if (uri === packageJson || !uri.endsWith(packageJson)) {
							invalidProj = true;
							// badPackage = true;
						}

						var obj = JSON.parse(fs.readFileSync(uri, 'utf8'));
						if (invalidProj && !badPackage) {
							dataObjPointer = parseData.dependencies[obj.name];
							if (obj._from && obj._resolved && obj.version) {
								if (!dataObjPointer) {
									dataObjPointer = {};
								}
								dataObjPointer.from = obj._from;
								dataObjPointer.resolved = obj._resolved;
								dataObjPointer.version = obj.version;
								invalidProj = false;
							} else {
								var pointerString = '["' + joinedStr.replace(/node_modules/gi, "dependencies");
								var objPointer = 'parseData' + pointerString;
								if (!eval(objPointer)) {
									var parentDepPointer = getParentDepPointer(pointerString);
									invalidDeps.push(parentDepPointer);
									objPointer = 'parseData' + parentDepPointer;
								}
								var parentDep = eval('delete ' + objPointer);
								obj.name = path[path.length - 1];
							}
						}
					} catch (e) {
						console.log(e);
					}

		       		if( (!invalidProj) && (obj.dist || obj._shasum) && dataObjPointer){
		       			//cli.ok('Founded dependencie shasum');
						if (obj._resolved) {
							var resolved = obj._resolved;
							dataObjPointer.resolved = obj._resolved.substring(resolved.lastIndexOf(SLASH) + 1);
						}
		       			if(obj.dist){
		       				dataObjPointer.shasum = obj.dist.shasum;
		       				path.shasum = obj.dist.shasum;
		       			}
		       			if(obj._shasum){
		       				dataObjPointer.sha1 = obj._shasum;
		       				dataObjPointer.shasum = obj._shasum;
		       				path.shasum = obj._shasum;
		       				path.sha1 = obj._shasum;
		       			}

		       			foundedShasum++;
		       		}else{//couldn't find shasum key
		       			missingShasum++;
		       			cli.info('Missing : ' +  obj.name);
		       		}
	       		
	         }
		}
	}

	cli.info("Total shasum found: " + foundedShasum);
	cli.info("Missing shasum: " + missingShasum);
  	cli.info("Total project dependencies: " + (missingShasum + foundedShasum));

  	return WsNodeReportBuilder.refitNodes(parseData);
};

WsNodeReportBuilder.traverseYarnData = function(lsDeps, yarnDependencies){
	cli.ok("Building dependencies report");

	// Build a map of dependencies and specific versions from the yarn.lock file data
	var yarnDependenciesMap = {};
	for (let depName in yarnDependencies) {
		if (!Object.hasOwnProperty.call(yarnDependencies, depName)) {
			continue;
		}

		const packageSeparatorIndex = depName.lastIndexOf('@');
		let packageName = depName;
		const details = yarnDependencies[depName];
		if (!details.resolved) {
			cli.info('Missing install url: ' +  depName);
			continue;
		}

		if (packageSeparatorIndex > 0) {
			packageName = depName.substr(0, packageSeparatorIndex);
		}

		let packageInfo = yarnDependenciesMap[packageName];
		if (!packageInfo) {
			packageInfo = yarnDependenciesMap[packageName] = {};
		}

		if (details.version in packageInfo) {
			// We've already seen this package version
			continue;
		}

		let shasum = null;
		let hashIndex = details.resolved.indexOf('#');
		let url = details.resolved;
		if (hashIndex > 0) {
			shasum = details.resolved.substr(hashIndex + 1);
			url = details.resolved.substr(0, hashIndex);
		} else {
			const urlParts = /\/tar.gz\/([0-9a-f]+)$/.exec(details.resolved);
			if (urlParts) {
				shasum = urlParts[1];
				url = url.substr(0, url.length - urlParts[1].length - 1);
			}
		}

		packageInfo[details.version] = {
			resolved: details.resolved,
			shasum,
			sha1: shasum,
			artifactId: url
		};
	}

	// augument the missing npm ls data with the yarn.lock file data
	function augmentDepInfo(details, name) {
		if (name) {
			if (!(name in yarnDependenciesMap)) {
				cli.info('Missing yarn dependency: ' + name);
				return;
			}
			if (!(details.version in yarnDependenciesMap[name])) {
				cli.info('Missing yarn dependency version: ' + name + ' ' + details.version);
				return;
			}
			
			Object.assign(details, yarnDependenciesMap[name][details.version]);
			delete details.resolved;
			details.from = name + '@' + details.version;
		}
		if (details.dependencies) {
			for (let subDepName in details.dependencies) {
				if (!Object.hasOwnProperty.call(details.dependencies, subDepName)) {
					continue;
				}
				augmentDepInfo(details.dependencies[subDepName], subDepName);
			}
		}
	}
	augmentDepInfo(lsDeps);
	
	return WsNodeReportBuilder.refitNodes(lsDeps);
};

