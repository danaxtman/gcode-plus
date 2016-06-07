#!/usr/bin/env node
/*
 *	Copyright (c) 2016 Versabuilt, Inc.
 *	
 *	
 *	Permission is hereby granted, free of charge, to any person obtaining 
 *	a copy of this software and associated documentation files (the "Software"), 
 *	to deal in the Software without restriction, including without limitation 
 *	the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 *	and/or sell copies of the Software, and to permit persons to whom the 
 *	Software is furnished to do so, subject to the following conditions:
 *	
 *	The above copyright notice and this permission notice shall be included 
 *	in all copies or substantial portions of the Software.
 *	
 *	THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, 
 *	EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF 
 *	MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. 
 *	IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, 
 *	DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, 
 *	ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 *	DEALINGS IN THE SOFTWARE.
 */

/**
 * A pre-processor for g-code
 * 
 * commands start with @ in first column of line:
 * 

 * include and preprocess a file at the current location
 * 		@include <[file name]>
 * define a macro variable substitution
 *		@define [macro name] = [macro variable number | macro argument letter]
 * define a macro program
 *		O@[macro name]
 * delay 
 *		@delay(seconds)
 * 
 */
'use strict';
const fs = require("fs");
const path = require("path");
const program = require('commander');
const mkdirp = require('mkdirp');
const vm = require('vm');

// ifStack values
const IF_TRUE		= 0;
const IF_FALSE		= 1;
const PARENT_FALSE  = 2;
const ifStates = ["IF_TRUE", "IF_FALSE", "PARENT_FALSE"];
'use strict';

class GPlus {
	constructor() {
	}
	
	compile(file, defines) {
		defines.outputDir = defines.outputDir || "";
		defines.progNumFileName = !!(defines.progNumFileName || defines.progNumFileName === undefined);
		defines.verbose = !!defines.verbose;
		defines.fileExtension = defines.fileExtension || "nc";
		defines.leader = defines.leader || "%";
		defines.trailer = defines.trailer || "%";
		var constants = {A:1,B:2,C:3,I:4,J:5,K:6,D:7,E:8,F:9,H:11,M:13,
			Q:17,R:18,S:19,T:20,U:21,V:22,W:23,X:24,Y:25,Z:26};
			this.env = Object.assign({}, constants, defines);
		this.context = new vm.createContext(this.env);
		this.ifStack = [];
		this.switchStack = [];
		this.inSwitch = null;
		this.ifStackStack = [];
		this.ifState = undefined;
		this.fileStack = [];
		this.inLineStack = [];
		this.inHeader = false;
		this.header = [];
		this.curProg = null;
		this.programs = {};
		this.file = null;
		this.warningCount = 0;
		this.errorCount = 0;
		this.autoProgNum = 7000;
		this.parseFile(file);
		this.output();
	}


	output() {
		var fail = this.errorCount !== 0;
		console.log("%s. %d errors, %d warnings", fail ? "Failure" : "Success",  this.errorCount, this.warningCount);
		if(!fail) {
			mkdirp.sync(this.env.outputDir);
			for(var progName in this.programs) {
				var prog = this.programs[progName];
				prog.lines = prog.lines.filter(l =>  ((l.line && l.line.length) || (this.env.verbose && l.comment && l.comment.length)))
				var output = this.env.leader + "\r\nO" + prog.progNum + " (" + prog.name + ") ;\r\n" +
					prog.header.map(l => "(" + l + ") ;").join("\r\n") + 
					(prog.header.length ? "\r\n":"") +
					prog.lines
					.filter(l => false &&  (l.line && l.line.length) || (l.comment && l.comment.length))
					.map(l => {
						var eob = this.env.verbose ? " (" + l.file + ":" + l.inLine +  (l.comment ? " " +l.comment : "") + ") ;" : " ;"
						if(l.line) {
							l.line = l.line.replace(/(;.*)/, "");
							var eob = this.env.verbose ? " (" + l.file + ":" + l.inLine +  (l.comment ? " " +l.comment : "") + ") ;" : " ;"
							return l.line + eob;
						}
						return eob;
					})
					.join("\r\n") +  "\r\n" + this.env.trailer;
				var fileName = path.join(this.env.outputDir, (this.env.progNumFileName ? prog.progNum.toString() : prog.name) + "." + this.env.fileExtension);
				try {
					fs.writeFileSync(fileName, output);
				}
				catch(err) {
					console.error("Error writing file %s - %s", fileName, err.message);
				}
			}
		}
	}

	globSnap() {
		return Object.assign({}, this.env);
	}

	globClean(snap) {
		this.env = snap;
		this.context = new vm.createContext(this.env);
	}
	
	parseFile(file) {
		var e;
		this.fileStack.push(this.file);
		this.inLineStack.push(this.inLine);
		this.ifStackStack.push(this.ifStack);
		this.inLine = 0;
		this.file = file;
		try {
			var data = fs.readFileSync(file, 'utf8');
		}
		catch(err) {
			this.error("file read - " + err.message);
			return;
		}
		
		var lines = data.split("\n").map(line => line.trim());
		for (var i = 0; i < lines.length; i++) {
			this.parseLine(lines[i]);
		}
		
		if(this.ifStack.length) {
			this.error("unterminated @if at %s:%d", this.ifStack[this.ifStack.length - 1]);
		}
		if(this.inHeader) {
			this.error("unterminated @header at %s:%d", this.inHeader);
		}
		if(this.curProg) {
			this.error("unterminated program", this.curProg);
		}
		if(this.inSwitch) {
			this.error("unterminated switch", this.inSwitch);
		}

		this.inSwitch = null;
		this.inHeader = null;
		this.file = this.fileStack.pop();
		this.inLine = this.inLineStack.pop();
		this.ifStack = this.ifStackStack.pop();
	}
	
	eval(expr) {
		//console.log("eval: " + expr);
		//console.log("eval:" + Object.getOwnPropertyNames(this.env));
		try {
			var script = new vm.Script(expr, {
				filename: this.file,
				timeout: undefined,
				columnOffset: 0,
				lineOffset: this.inLine,
			});
			var v = script.runInContext(this.context);
			//console.log("eval %s=%j",expr,v);
			return v;
		}
		catch(err) {
			//this.error(`expression error: ${err.message}`);
			return undefined;
		}
	}
	

	error(message, at) {
		if(at) {
			var msg = console.error(`${this.file}:${this.inLine} error: ${message} at ${at.file}:${at.inLine}`);
		} else {
			var msg = console.error(`${this.file}:${this.inLine} error: ${message}`);
		}
		this.errorCount++;
	}

	warning(message, at) {
		if(at) {
			var msg = console.warn(`${this.file}:${this.inLine} error: ${message} at ${at.file}:${at.inLine}`);
		} else {
			var msg = console.warn(`${this.file}:${this.inLine} error: ${message}`);
		}
		this.warningCount++;
	}

	
	addLine(line, comment) {
		//console.log("addLine:" + line);
		var nl = { file: this.file, inLine: this.inLine, outLine:this.outLine++, line: line, comment: comment };
		if(this.curProg) {
			this.curProg.lines.push(nl);
		} else if(line) {
			this.error("program line outside of program or clip");
		}
		return nl;
	}
	
	ifPush(state) {
		//console.log("%s:%d if push new:%s, old:%s, stack:%j", this.file, this.inLine, ifStates[state], ifStates[this.ifState], this.ifStack);
		this.ifStack.push(this.ifState);
		this.ifState = state;
	}

	ifPop() {
		var old = this.ifState;
		this.ifState = this.ifStack.pop();
		if(this.ifState === null) {
			this.ifState = undefined;
		}
		//console.log("%s:%d if pop new:%s, old:%s, stack:%j", this.file, this.inLine, ifStates[this.ifState], ifStates[old], this.ifStack);
		return this.ifState;
	}

	ifSet(state) {
		//console.log("%s:%d if set new:%s, old:%s, stack:%j", this.file, this.inLine, ifStates[state], ifStates[this.ifState], this.ifStack);
		this.ifState = state;
	}


	resolve() {
		var replacements = "";

		var line;
		var self = this;
		function resolveName(match, p1, p2) {
			var val = self.eval(p2); 
			if(val === undefined) {
				self.error(p2 + " undefined", line);
				val = p2;
			} else {
				replacements = replacements + (replacements.length ? ",":"") + val + "=" + p2;
			}
			return val;
		}

		for (var i = 0; i < this.curProg.header.length; i++) {
			this.curProg.header[i] = this.curProg.header[i].replace(/(@)(\w+)/g, resolveName);
		}


		for (i = 0; i < this.curProg.lines.length; i++) {
			line = this.curProg.lines[i];
			if(line.line) {
				replacements = "";
				line.line = line.line.replace(/(@)(\w+)/g, resolveName);
				if(replacements.length) {
					line.comment = (line.comment ? line.comment + "," : "") + replacements 
				}
				replacements = "";
				line.line = line.line.replace(/(@")([^"]*)/g, resolveName);
				if(replacements.length) {
					line.comment = (line.comment ? line.comment : "") + replacements 
				}
			}
		}
	}

	
	parseLine(line) {
		var clip, name, m;
		this.inLine++;
		
		//console.log("line " + this.inLine);
		
		// bail if empty
		if(!line.length) {
			return;
		}

		// comments
		if(m = line.match(/^\/\/(.+)/)) {
			if(this.curProg && this.ifState === IF_TRUE) {
				this.addLine(null, m[1]);
			}
			return;
		}
		
		if(this.ifState === IF_TRUE || this.ifState === undefined) {
			// header start
			if(m = line.match(/^@endheader/)) {
				if(!this.inHeader) {
					this.warn("not in header");
				}
				this.inHeader = false;
				return;
			}

			// store header line
			if(this.inHeader) {
				if(this.curProg) {
					this.curProg.header.push(line);
				} else {
					this.header.push(line);
				}
				return;
			}
		}
		
		// @if
		if(m = line.match(/^@if\s*(.+)/))  {
			if(this.ifState === IF_FALSE || this.ifState === PARENT_FALSE) {
				this.ifPush(PARENT_FALSE);
			} else {
				if(this.eval(m[1])) {
					this.ifPush(IF_TRUE);
				} else {
					this.ifPush(IF_FALSE);
				}
			}
			return;
		} 
		
		// @else
		if(m = line.match(/^@else/)) {
			switch(this.ifState) {
			case undefined:
				this.error("@else without if");
				return;
			case PARENT_FALSE:
				// do nothing 
				return;
			case IF_TRUE:
				this.ifSet(IF_FALSE);
				return;
			case IF_FALSE:
				this.ifSet(IF_TRUE);
				return;
			}
			return;
		} 

		// @endif
		if(line.match(/^@endif/)) {
			if(this.ifState === undefined) {
				this.error("@endif without if");
				return;
			}
			this.ifPop();
			return;
		} 
		
		// everything below here ignored if not true
		if(this.ifState !== IF_TRUE && this.ifState !== undefined) {
			return;
		}

		// @error
		if(m = line.match(/^@print\s+(.*)/)) {
			console.log("%s:%d print: %s = %s", this.file, this.inLine, m[1], this.eval(m[1]) );
			return;
		} 


		// @error
		if(m = line.match(/^@error\s+(.*)/)) {
			this.error("@error " + m[1]);
			process.exit(1);
		} 
			
		// header start
		if(m = line.match(/^@header/)) {
			this.inHeader = { inLine: this.inLine, file: this.file };
			return;
		}
			
		// @program	
		if(m = line.match(/^@program\s+(\w+)/)) {			
			name = m[1].trim();
			if(this.inBuildCase) {
				this.error("program in buildcase", this.inBuildCase);
			}
			else if(this.curProg) {
				this.error("programs cannot be nested");
			} else {
				var progNum = this.env[name];
				if(!progNum || !Number.isInteger(progNum)) {
					this.error(name + " not defined");
				}
				if(!Number.isInteger(progNum)) {
					this.error(name + " must be integer");
				}
				var exists = this.programs[name];
				if(exists) {
					this.warning("overwriting program %s already defiend at %s:%d", name, exists.line);
				}
				
				this.curProg = { 
					line: this.inLine, 
					file: this.file, 
					progNum: progNum,
					name: name, 
					lines: [], 
					clip: clip, 
					done: false, 
					locals:{},
					header: this.header.slice(), 
					unresolved: [],
					snap: this.globSnap(),
				};
				this.outLine = 0;
				this.programs[name] = this.curProg;
			}
			return;
		} 
	


		// @include
		if(m = line.match(/^@include\s+([\w\.]+)/)) {
			name = m[1];
			this.parseFile(name);
			return;
		} 
		
		// @eval
		if(m = line.match(/^@eval\s+(.*)/)) {
			this.eval(m[1]);
			return;
		} 

		// @define
		if(m = line.match(/^@define\s+(.*)/)) {
			this.eval("var " + m[1]);
			return;
		} 

		// everything below here must be in the context of a program
		if(!this.curProg) {
			return;
		}

		// @endprogram
		if(m = line.match(/^@endprogram/)) {
			if(this.curProg) {
				this.curProg.done = true;
				this.resolve();	
				this.globClean(this.curProg.snap);	
				this.curProg = null;
			} else {
				this.error("not in program", false);
			}
			return;
		} 


		if(m = line.match(/^@switch\s+(.*)/)) {
			let s = { 
				line: this.inLine, 
				file: this.file, 
				inCase: false,
				cases: [], 
				outLine: this.curProg.lines.length,
			};
			this.switchStack.push(this.inSwitch);
			this.inSwitch = s;
			return;
		}
		if(m = line.match(/^@endswitch/)) {
			if(!this.inSwitch) {
				this.error("@case outside switch");
				return;
			} else {
				let jt = [];
				
				// insert jumps for each case
				for (let i = 0; i < this.inSwitch.cases.length; i++) {
					let c = this.inSwitch.cases[i];
					jt.push(`IF[${this.inSwitch.switch} EQ c.val] GOTO@__${this.switchStack.length}_${i+1}`);
				}
				
				// insert default case jump
				if(this.inSwitch.defaultCase) {
					jt.push(`GOTO@__${this.switchStack.length}_default`);
				} else {
					// jump to endcase
					jt.push(`GOTO@__${this.switchStack.length}_endswitch`);
				}
				
				// inset jump table lines at @switch location
				this.curProg.lines.splice(this.inSwitch.outLine, 0, ...jt);
				
				// output endcase jump point
				line = `N@__${this.switchStack.length}_endswitch`;
				this.inSwitch = this.switchStack.pop();
				// fall through !!
			}
		}

		if(m = line.match(/^@case\s+(.*)/)) {
			if(!this.inSwitch) {
				this.error("@case outside switch");
				return;
			} else {
				this.inSwitch.cases.push({
					line: this.inLine, 
					file: this.file, 
				});
				this.inSwitch.inCase = true;
				// insert a block number with a symbol for the jump table
				line = `N@__${this.switchStack.length}_${this.inSwitch.cases.length}`;
				// fall through !!
			}
		}
		if(m = line.match(/^@endcase/)) {
			if(!this.inSwitch) {
				this.error("@endcase outside switch");
				return;
			} 
			
			else {
				this.inSwitch.inCase = false;
				// jump to the end of the switch
				line = `GOTO@__${this.switchStack.length}_endswitch`;
				// fall through !!
			}
		}
		if(m = line.match(/^@defaultcase/)) {
			if(!this.inSwitch) {
				this.error("@case outside switch");
				return;
			}
			if(this.inSwitch.defaultCase) {
				this.error("switch already has @defaultcase", this.inSwitch.defaultCase);
				return;
			}
			else {
				this.inSwitch.defaultCase = {
					line: this.inLine, 
					file: this.file, 
				};
				this.inSwitch.inCase = true;
				// insert a block number with a symbol for the jump table
				line = `N@__${this.switchStack.length}_default`;
				// fall through !!
			}
		}


		// delay
		if(m = line.match(/^@delay\s+(.*)/)) {
			this.addLine(`G04 P${this.eval(m[1])} ;`, m[1]);
			return;
		} 

		// block numbers
		if(m = line.match(/^N(@)(\w+)/)) {
			// if name not otherwise defined, define it as the line number
			if(!global[m[2]]) {
				this.eval(`const ${m[2]} = ${this.outLine}`);
			}
		}
		
		this.addLine(line);
	}
	

	
}

program
  .version('0.0.1')
  .usage('[options] <file ...>')
  .option('-o, --output [path]', 'The output path. default: [./]')
  .option('-c, --controller [controller]', 'The controller type')
  .option('-m, --model [model]', 'The machine model')
  .option('-l, --leader [leader]', 'The leader before a program. [%]')
  .option('-t, --trailer [trailer]', 'The trailer after a program. default: [%]')
  .option('-e, --extension [value]', 'Output file extension. [.nc]')
  .option('-p, --prog-name', 'Use program name as file name default: use program number')
  .option('-v, --verbose', 'Output debug comments.')
  .parse(process.argv);


var gp = new GPlus(); 
var parameters = {
	outputDir: program.output,
	control: program.controller,
	model: program.model,
	leader: program.leader,
	trailer: program.trailer,
	fileExtension: program.extension,
	progNumFileName: !program.progName,
	verbose: program.verbose,		
}; 

//console.log("%j\r\n%j", parameters, program);
 
for (var i = 0; i < program.args.length; i++) {
	gp.compile(program.args[i], parameters);
}
