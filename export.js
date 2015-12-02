// Node TFS Rally Import Barry Mullan 2015

var config = require('./config.json');

var csv = require('ya-csv');
var fs = require("fs");
var _ = require('lodash');
var async = require('async');

var rally = require('rally'),
	refUtils = rally.util.ref,
 	queryUtils = rally.util.query;

var restApi = rally(config);
var users = [];
var projects = [];
var workspace = null;
var parentFeature = null;
var parentStory = null;

var header = ['FormattedID','Name', 'Project', 'Project Name', 'ObjectID', 'Parent','Parent Name','TestCaseCount', 'TestFolder', 'TestFolder Name'];


var readAllTestFolders = function(callback) {

	restApi.query({
	    type: 'testfolder', //the type to query
	    start: 1, //the 1-based start index, defaults to 1
	    pageSize: 200, //the page size (1-200, defaults to 200)
	    limit: 'Infinity', //the maximum number of results to return- enables auto paging
	    // order: 'Rank', //how to sort the results
	    fetch: ['FormattedID','Name', 'Project', 'ObjectID', 'Children','Parent','TestCases'], //the fields to retrieve
	    query: {}, // queryUtils.where('State', '=', "Open"), //optional filter
	    scope: {
	        workspace: workspace._ref, // '/workspace/1234' //specify to query entire workspace
	        project: config['source-project'],
	        up: false, //true to include parent project results, false otherwise
	        down: true //true to include child project results, false otherwise
	    },
	    requestOptions: {} //optional additional options to pass through to request
	}, function(error, result) {
	    if(error) {
	        console.log("Error",error);
	        callback(error,result);
	    } else {
	        // console.log(result.Results);
	        callback(null,result);
	    }
	});

}

var readWorkspaceRef = function(workspaceName,callback) {

	restApi.query({
	    type: 'workspace', //the type to query
	    start: 1, //the 1-based start index, defaults to 1
	    pageSize: 200, //the page size (1-200, defaults to 200)
	    limit: 'Infinity', //the maximum number of results to return- enables auto paging
	    // order: 'Rank', //how to sort the results
	    fetch: ['Name', 'ObjectID'], //the fields to retrieve
	    // query: queryUtils.where('ObjectID', '!=', 0), //optional filter
	}, function(error, result) {
	    if(error) {
	        console.log("Error",error);
	        callback(error,null);
	    } else {
	    	// console.log("ws results",result);
			var workspace = _.find(result.Results,function(r) {
	        	return r.Name === workspaceName;
	        });
	        callback(null,workspace)
	    }
	});

}

var readCsvFile = function( filename, callback) {

	console.log("reading filename ... ",filename);

	fs.exists(filename, function (exists) {
		var that = this;
	  	if (exists) {
			var reader = csv.createCsvFileReader(filename);
			var header = [];
			var records = [];

			reader.addListener('data',function(record) {
				if (header.length === 0)
					header = record;
				else {
					var obj = {};
					_.each(header,function(key,x){
						obj[key] = record[x];
					})
					records.push(obj);
				}
				console.log(record[0]);
			});

			reader.addListener('end',function(){
				callback(records);
			});
		} else {
			console.log("file does not exist ",filename);
		}
	});
};

var writeRecord = function( rec, writer) {

	writer.writeRecord(
		_.map(header,function(h) { 
			// ['FormattedID','Name', 'Project', 'Project Name', 'ObjectID', 'Parent', 'Parent Name','TestCaseCount'];
			switch(h) {
				case 'Project' : return rec.Project.ObjectID;
				case 'Project Name' : return rec.Project._refObjectName;
				case 'Parent' : return (_.isNull(rec.Parent) ? "" : rec.Parent.ObjectID);
				case 'Parent Name' : return (_.isNull(rec.Parent) ? "" : rec.Parent._refObjectName);
				case 'TestCaseCount' : return rec.TestCases.Count;
				case 'TestFolder' : return (_.isUndefined(rec.TestFolder) ? "" : rec.TestFolder.ObjectID);
				case 'TestFolder Name' : return (_.isUndefined(rec.TestFolder) ? "" : rec.TestFolder._refObjectName);

				default : return rec[h];
			}
		})
	);
};

var writeFolderAndTestCases = function(folder, writer, tcWriter) {

	// dont write if in excluded folder
	if (_.indexOf(config["exclude-projects"],folder.Project._refObjectName)==-1) {
		console.log(folder.Name);
		writeRecord(folder,writer);

		restApi.query( {
			ref : folder.TestCases._ref,
			start : 1, pageSize: 200, limit : 'Infinity', order: 'FormattedID', 
			fetch : ['FormattedID','Name', 'Project', 'ObjectID', 'TestFolder'], //the fields to retrieve
		}).then(function(results){
			if (!_.isUndefined(results.Results)) {
				_.each(results.Results,function(tc){
					tcWriter.writeRecord([tc.ObjectID,tc.FormattedID,tc.Name,tc.Project.ObjectID,tc.TestFolder.ObjectID]);
				})
			} else {
			}
		}).fail(function(errors){
			console.log("errors");
		})				
	}

};

var exportData = function() {

	readWorkspaceRef(config.workspace,function(err,ws) {
		// console.log("Workspace",ws);
		workspace = ws;
		async.series([readAllTestFolders],function(err,results) {

			var writer = csv.createCsvStreamWriter(fs.createWriteStream(config["folder-file-name"]));
			var tcWriter = csv.createCsvStreamWriter(fs.createWriteStream(config["testcase-file-name"]));

			writer.writeRecord(header);
			tcWriter.writeRecord(["ObjectID","FormattedID","Name","Project.ObjectID","TestFolder.ObjectID"]);
			
			_.each(_.first(results).Results,function(folder){
				writeFolderAndTestCases(folder,writer,tcWriter);
			});

		});
	});
};

var disconnectTestCases = function(stepName) {

	var stepFileName = stepName+".csv";

	var x = 0;
	var total = 0;

	var writer = csv.createCsvStreamWriter(fs.createWriteStream(stepFileName,{'flags': 'a'}));

	var q = async.queue(function (testcase, callback) {
	    console.log(testcase.FormattedID);
		restApi.update({
			ref: '/testcase/' + testcase.ObjectID,
		data: {
    		TestFolder: null
		},
	    fetch: ['FormattedID'],
	    scope: {
	        // workspace: ws._ref
	    },
		requestOptions: {} //optional additional options to pass through to request
		}, function(error, result) {
		    if(error) {
		        console.log(testcase.FormattedID,error);
		    } else {
		        // console.log(result.Object);
		        writer.writeRecord([testcase.ObjectID]);
		    }
		    total = total -1;
		    if (total % 10 ===0) { console.log("Remaining:",total)};
        	callback();
		});
	}, 1);

	readCsvFile(config['testcase-file-name'], function(records) {
		total = records.length;
		q.push(records, function (err) {
			// console.log('finished processing item');
		});
	});
};

var unparentTestFolders = function(stepName) {
	var stepFileName = stepName+".csv";
	var total = 0;
	var writer = csv.createCsvStreamWriter(fs.createWriteStream(stepFileName,{'flags': 'a'}));
	var q = async.queue(function (testfolder, callback) {
			// console.log(testfolder.FormattedID);
			restApi.update({
    			ref: '/testfolder/' + testfolder.ObjectID,
    		data: {
        		Parent: null
    		},
		    fetch: ['FormattedID'],
		    scope: {
		        // workspace: ws._ref
		    },
    		requestOptions: {} //optional additional options to pass through to request
			}, 
			function(error, result) {
			    if(error) {
			        console.log("Error!",error);
			    } else {
    		        writer.writeRecord([testfolder.ObjectID]);
			    }
			    total = total -1;
		    	if (total % 10 ===0) { console.log("Remaining:",total)};
        		callback();
        	})
	}, 1);

	readCsvFile(config['folder-file-name'], function(records) {
		total = records.length;
		q.push(records, function (err) {
		});
	});
};


var reconnectTestCases = function(stepName) {

	var stepFileName = stepName+".csv";
	var total = 0;

	var writer = csv.createCsvStreamWriter(fs.createWriteStream(stepFileName,{'flags': 'a'}));

	var q = async.queue(function (testcase, callback) {
	    console.log(testcase.FormattedID);
		restApi.update({
			ref: '/testcase/' + testcase.ObjectID,
		data: {
    		TestFolder: '/testfolder/'+testcase["TestFolder.ObjectID"]
		},
	    fetch: ['FormattedID'],
	    scope: {
	        // workspace: ws._ref
	    },
		requestOptions: {} //optional additional options to pass through to request
		}, function(error, result) {
	    if(error) {
	        console.log(testcase.FormattedID,error);
	    } else {
	        // console.log(result.Object);
	        writer.writeRecord([testcase.ObjectID]);
	    }
	    total = total -1;
	    if (total % 10 ===0) { console.log("Remaining:",total)};
    	callback();
		});
	}, 1);

	readCsvFile(config['testcase-file-name'], function(records) {
		total = records.length;
		q.push(records, function (err) {
			// console.log('finished processing item');
		});
	});

};

var reparentTestFolders = function(stepName) {

	var stepFileName = stepName+".csv";
	var total = 0;
	var writer = csv.createCsvStreamWriter(fs.createWriteStream(stepFileName,{'flags': 'a'}));

	var q = async.queue(function (testfolder, callback) {
		console.log(testfolder.FormattedID);
			var testParentRef = (testfolder.Parent!=="") 
				? '/testfolder/' + testfolder.Parent
				: config["parent-test-folder"];

			// if (testfolder.Parent!=="") {
			restApi.update({
    			ref: '/testfolder/' + testfolder.ObjectID,
    		data: {
        		// Parent: '/testfolder/' + testfolder.Parent
        		Parent : testParentRef !== "" ? testParentRef : null
    		},
		    fetch: ['FormattedID'],
		    scope: {
		        // workspace: ws._ref
		    },
    		requestOptions: {} //optional additional options to pass through to request
			}, function(error, result) {
			    if(error) {
			        console.log("Error!",error);
			    } else {
    		        writer.writeRecord([testfolder.ObjectID]);
			    }
			    total = total -1;
		    	if (total % 10 ===0) { console.log("Remaining:",total)};
        		callback();
        	})
	}, 1);

	readCsvFile(config['folder-file-name'], function(records) {
		total = records.length;
		q.push(records, function (err) {
		});
	});

};


var moveItems = function(filename, type, destination, stepName) {

	var stepFileName = stepName+".csv";
	var total = 0;
	var writer = csv.createCsvStreamWriter(fs.createWriteStream(stepFileName,{'flags': 'a'}));
	var q = async.queue(function (record, callback) {

		console.log(record.FormattedID);
				restApi.update({
	    			ref: '/'+type+'/' + record.ObjectID,
	    		data: {
	        		Project: destination
	    		},
			    fetch: ['FormattedID'],
			    scope: {
			        // workspace: ws._ref
			    },
	    		requestOptions: {} //optional additional options to pass through to request
				}, function(error, result) {	
				    if(error) {
				        console.log("Error!",error);
				    } else {
	    		        writer.writeRecord([record.ObjectID]);
				    }
				    total = total -1;
			    	if (total % 10 ===0) { console.log("Remaining:",total)};
	        		callback();
        		})
		

			
	}, 1);

	readCsvFile(filename, function(records) {
		total = records.length;
		q.push(records, function (err) {
		});
	});

};


// run using the following steps eg. 
// node export.js export
// node export.js step2
// node export.js step3 etc.

// 1. Export folders and testcases csv files.

// 2. Disconnect test cases
// iterate set of test cases, set TestFolder to null and update.

// 3. Unparent Test Folders
// iterate test folders, set Parent to null and update.

// 4. Move test cases
// iterate test cases set project to new project and update.

// 5. Move test folders
// iterate test folders, set project to new project and update.

// 6. Reparent folders
// iterate folders, set parent and update

// 7. Reconnect testcases.
// iterate tests, set folder and update


console.log( "arg:",process.argv[2]);

switch( process.argv[2]) {

	case 'export': exportData(); break;

	case 'step2' : disconnectTestCases("step2"); break;

	case 'step3' : unparentTestFolders("step3"); break;

	case 'step4' : moveItems( config['testcase-file-name'], 'testcase', config['destination-project'], "step4"); break;

	case 'step5' : moveItems( config['folder-file-name'], 'testfolder', config['destination-project'], "step5"); break;

	case 'step6' : reparentTestFolders("step6"); break;

	case 'step7' : reconnectTestCases("step7"); break;
}








