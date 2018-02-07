'use strict';

import * as fs from 'fs';

import cpf = require('cp-file');
import globParent = require('glob-parent');
import globby = require('globby');
import minimatch = require('minimatch');

import glob = require('glob');

import LogManager from './managers/log';
import * as optionsManager from './managers/options';

import * as fsUtils from './utils/fs';
import * as pathUtils from './utils/path';

import { ILogEntry, Log } from './managers/log';
import { IOptions, IPartialOptions } from './managers/options';
import { Pattern } from './types/patterns';

/**
 * The reason to  not update the file
 */
export function skipUpdate(source: fs.Stats, dest: fs.Stats | null, updateAndDelete: boolean): boolean {
	if (dest && !updateAndDelete) {
		return true;
	}
	if (source.isDirectory()) {
		return true;
	}
	if (dest && compareTime(source, dest)) {
		return true;
	}

	return false;
}

/**
 * Compare update time of two files
 */
export function compareTime(source: fs.Stats, dest: fs.Stats): boolean {
	return source.ctime.getTime() < dest.ctime.getTime();
}

export function getDestEntries(dest: string): Promise<string[]> {
	const options: glob.IOptions = {
		cwd: dest,
		dot: true,
		nosort: true
	};

	return globby('**', options);
}

export function getSourceEntries(patterns: Pattern | Pattern[]): Promise<string[]> {
	const options: glob.IOptions = {
		dot: true,
		nosort: true
	};

	return globby(patterns, options);
}

export async function run(patterns: Pattern[], dest: string, sourceFiles: string[], options: IOptions, log: Log): Promise<void[]> {
	const arrayOfPromises: Array<Promise<void>> = [];

	// If destination directory not exists then create it
	await fsUtils.pathExists(dest).then((exists) => {
		if (!exists) {
			return fsUtils.makeDirectory(dest);
		}

		return;
	});

	// Get files from destination directory
	const destFiles = await getDestEntries(dest);

	// Get all the parts of a file path for excluded paths
	const excludedFiles = (<Pattern[]>options.ignoreInDest).reduce((ret, pattern) => {
		return ret.concat(minimatch.match(destFiles, pattern, { dot: true }));
	}, [] as string[]).map((filepath) => pathUtils.pathFromDestToSource(filepath, options.base));

	let partsOfExcludedFiles: string[] = [];
	for (const excludedFile of excludedFiles) {
		partsOfExcludedFiles = partsOfExcludedFiles.concat(pathUtils.expandDirectoryTree(excludedFile));
	}

	// Removing files from the destination directory
	if (options.updateAndDelete) {
		// Create a full list of the basic directories
		let treeOfBasePaths = [''];
		patterns.forEach((pattern) => {
			const parentDir = globParent(pattern);
			const treePaths = pathUtils.expandDirectoryTree(parentDir);

			treeOfBasePaths = treeOfBasePaths.concat(treePaths);
		});

		const fullSourcePaths = sourceFiles.concat(treeOfBasePaths, partsOfExcludedFiles);

		// Deleting files
		for (const destFile of destFiles) {
			// To files in the source directory are added paths to basic directories
			const pathFromDestToSource = pathUtils.pathFromDestToSource(destFile, options.base);

			// Search unique files to the destination directory
			let skipIteration = false;
			for (const fullSourcePath of fullSourcePaths) {
				if (fullSourcePath.indexOf(pathFromDestToSource) !== -1) {
					skipIteration = true;
					break;
				}
			}

			if (skipIteration) {
				continue;
			}

			const pathFromSourceToDest = pathUtils.pathFromSourceToDest(destFile, dest, null);
			const removePromise = fsUtils.removeFile(pathFromSourceToDest, { disableGlob: true }).then(() => {
				log(<ILogEntry>{
					action: 'remove',
					from: destFile,
					to: undefined
				});
			}).catch((err) => {
				throw new Error(`Cannot remove '${pathFromSourceToDest}': ${err.code}`);
			});

			arrayOfPromises.push(removePromise);
		}
	}

	// Copying files
	for (const from of sourceFiles) {
		const to = pathUtils.pathFromSourceToDest(from, dest, options.base);

		// Get stats for source & dest file
		const statFrom = fsUtils.statFile(from);
		const statDest = fsUtils.statFile(to).catch(() => null);

		const copyAction = Promise.all([statFrom, statDest]).then((stat) => {
			// We should update this file?
			if (skipUpdate(stat[0], stat[1], options.updateAndDelete)) {
				return;
			}

			return cpf(from, to).then(() => {
				log(<ILogEntry>{
					action: 'copy',
					from,
					to
				});
			}).catch((err) => {
				throw new Error(`'${from}' to '${to}': ${err.message}`);
			});
		});

		arrayOfPromises.push(copyAction);
	}

	return Promise.all(arrayOfPromises);
}

export default async function syncy(source: Pattern | Pattern[], dest: string | string[], opts?: IPartialOptions): Promise<void[][]> {
	const patterns = ([] as Pattern[]).concat(source);
	const destination = ([] as string[]).concat(dest);

	const options = optionsManager.prepare(opts);

	const logManager = new LogManager(options);
	const logger = logManager.info.bind(logManager);

	return getSourceEntries(source).then((sourceFiles) => {
		return Promise.all(destination.map((item) => run(patterns, item, sourceFiles, options, logger)));
	});
}
