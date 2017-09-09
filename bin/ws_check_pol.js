var WsCheckPol = exports;
exports.constructor = function WsCheckPol(){};

WsCheckPol.check = function(resJson){
	console.log(resJson);
	var existingProjs = resJson.existingProjects;
	var newProjs = resJson.newProjects;
	var failBuild = false;
	var policyDeps = [];
	var newDeps = [];
	//check and handle existing projects
	if(existingProjs){
		for (key in existingProjs) {
			var projChildren = existingProjs[key].children;
			for(var i = 0; i<projChildren.length; i++){
					if(projChildren[i].policy){
						policyDeps.push(projChildren[i]);
						failBuild = true;
					}
			}
		}
	}

	//check and handle new projects
	if(newProjs){
		for (key in newProjs) {
			var projChildren = newProjs[key].children;
			for(var i = 0; i<projChildren.length; i++){
				newDeps.push(projChildren[i]);
				if(projChildren[i].policy){
					policyDeps.push(projChildren[i]);
					failBuild = true;
				}
			}
		}
	}
	if(policyDeps.length != 0){
		cli.error("Policy violations found exiting build");
		cli.info("See list of violations:");
		for(var i = 0; i<policyDeps.length; i++){
			cli.info(policyDeps[i].resource.displayName + " : " + policyDeps[i].policy.displayName);
		}
	}else{
	   cli.ok("No policy violations found");
	}
};