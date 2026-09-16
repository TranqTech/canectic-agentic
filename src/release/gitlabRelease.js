// gitlabRelease.js -- mirroring a cut release onto the GitLab releases page.
//
// The repository has carried a release object per tag since v0.9.0-alpha.1, all
// three made by hand, and the release script only ever tagged. So the first
// release cut by script would have been the first one missing from the page
// people actually look at.
//
// Worse than missing: GitLab generates "Source code (zip)" for every tag by
// itself, so the page looks like it has a download when what it has is a git
// tree. No MANIFEST, no CANECTIC.ID, no FILE_ID.DIZ, and installing it takes
// the from-source path rather than the bootstrap one. Every earlier release
// offered exactly that and nothing else.
//
// The host stays canonical: `update_check_url` points there, the bootstrap
// fetches from there, and the file echo carries the same artifact. GitLab is
// where a person finds a release and reads what changed.
//
// A mirror is safe here for one specific reason. The release is SIGNED, and the
// signature is over the content rather than over a location, so a copy
// somewhere else cannot say anything different from the original. Mirroring
// unsigned artifacts would be adding a second thing that can drift; mirroring
// signed ones is just another place to fetch the same bytes from.
//
// Publishing happens AFTER the artifact exists and is verified, and a failure
// here is reported rather than fatal: everything durable is already on disk and
// in the repository by then, and the manual command is one line.
//
// THE TAG MUST BE ON THE REMOTE FIRST, and this refuses when it is not. `glab
// release create` does not require an existing tag: given a tag name it does
// not recognise, it CREATES one, as a lightweight tag at the remote's current
// head. During a cut that is the commit before the release commit, because the
// cut has not pushed anything yet.
//
// The first signed release went out that way. The signed annotated tag stayed
// on the maintainer's machine, the remote got an unsigned lightweight tag
// pointing at the wrong commit, and the release page hung off that. Nothing
// about it looked wrong: the page was there, the assets were right, and the
// signature that was the whole point of the exercise was simply not present
// anywhere a person could check it.

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { artifactName, metadataName, manifestName, SUMS_FILENAME } from './metadata.js';
import { PUBLIC_KEY_FILENAME, signatureName } from './signing.js';

var PACKAGE_NAME = 'release-assets';

/** "Canectic BBS v0.9.6a", the form every earlier release object used. */
function releaseTitle(version) {
	return 'Canectic BBS v' + version;
}

/**
 * The release notes, as GitLab should show them.
 *
 * The leading `# Canectic BBS v0.9.6a` comes off: GitLab prints the release
 * name directly above the description, so keeping it renders the version twice
 * with the second one in a bigger typeface than the first.
 */
function releaseDescription(notes) {
	var lines = String(notes || '').split('\n');
	if (lines.length && /^#\s+\S/.test(lines[0])) lines.shift();
	while (lines.length && lines[0].trim() === '') lines.shift();
	return lines.join('\n').replace(/\s+$/, '') + '\n';
}

/**
 * The files worth attaching, in the order they should appear.
 *
 * The archive, the two sidecars that describe it, the checksum list with its
 * signature, and the public key. Deliberately NOT `bootstrap.sh`: it defaults
 * to fetching from the release host, so a copy downloaded from here would be a
 * trap for as long as the host is not serving. The archive on its own installs
 * fine, and the notes say how.
 */
function releaseAssets(version, opts) {
	var delta = !!(opts && opts.delta);
	return [
		artifactName(version, { delta: delta }),
		metadataName(version),
		manifestName(version),
		SUMS_FILENAME,
		signatureName(SUMS_FILENAME),
		PUBLIC_KEY_FILENAME
	];
}

/** Which of them are actually present, and which are not. An unsigned cut has
 *  no SHA256SUMS.asc, and that is a missing file rather than a failure. */
function resolveAssets(dir, version, opts) {
	var present = [];
	var absent = [];
	for (var name of releaseAssets(version, opts)) {
		var file = path.join(dir, name);
		(fs.existsSync(file) ? present : absent).push(name);
	}
	return { present: present, absent: absent };
}

/**
 * Does the remote already carry this tag, and is it the one we mean?
 *
 * `git ls-remote` rather than a local check: the local tag proves nothing about
 * what a reader of the release page will find. The dereferenced `^{}` line is
 * the commit an annotated tag points at, and its ABSENCE means the remote tag
 * is lightweight, which for a release tag means unsigned.
 *
 * @returns {{present:boolean, annotated:boolean, commit:string|null}}
 */
function remoteTag(version, cwd) {
	var out;
	try {
		out = execFileSync('git', ['ls-remote', '--tags', 'origin', 'refs/tags/v' + version,
			'refs/tags/v' + version + '^{}'], { cwd: cwd || process.cwd(), encoding: 'utf8' });
	} catch (e) {
		return { present: false, annotated: false, commit: null };
	}
	return parseRemoteTag(out);
}

/**
 * Read `git ls-remote --tags` output.
 *
 * Split out so the one distinction that matters can be tested without a remote:
 * a `^{}` line is the commit an annotated tag points at, and its ABSENCE means
 * the remote tag is lightweight. For a release tag, lightweight means unsigned,
 * which is the failure this whole guard exists to catch.
 */
function parseRemoteTag(out) {
	var lines = String(out || '').trim().split('\n').filter(Boolean);
	if (!lines.length) return { present: false, annotated: false, commit: null };

	var deref = lines.find(function (l) { return l.indexOf('^{}') !== -1; });
	return {
		present: true,
		annotated: !!deref,
		commit: (deref || lines[0]).split(/\s+/)[0]
	};
}

/** Is glab here and authenticated against the project's host? */
function gitlabAvailable() {
	try {
		execFileSync('glab', ['auth', 'status'], { stdio: 'ignore' });
		return true;
	} catch (e) {
		return false;
	}
}

/**
 * Create or update the release object for a tag.
 *
 * Assets go to the project's generic package registry, because a GitLab release
 * holds links rather than files and the registry is what gives those links
 * something to point at.
 */
function publishToGitLab(opts) {
	var version = opts.version;
	var dir = opts.output;
	var resolved = resolveAssets(dir, version, opts);
	if (!resolved.present.length) throw new Error('none of the release files are in ' + dir);

	// Refuse rather than let glab invent a tag. See the note at the top: it
	// creates one silently, unsigned, at whatever the remote head happens to be.
	var tag = remoteTag(version, opts.cwd);
	if (!tag.present) {
		throw new Error('the tag v' + version + ' is not on the remote yet, and creating the ' +
			'release now would make glab invent an unsigned one at the wrong commit.\n' +
			'  Push it first:   git push origin v' + version + '\n' +
			'  Then publish:    node scripts/release.mjs --publish ' + version);
	}
	if (!tag.annotated) {
		throw new Error('the tag v' + version + ' on the remote is lightweight, so it carries no ' +
			'signature.\n  Replace it with the signed one:\n' +
			'    git push origin :refs/tags/v' + version + ' && git push origin v' + version);
	}

	var notesFile = path.join(dir, '.gitlab-release-notes.md');
	fs.writeFileSync(notesFile, releaseDescription(opts.notes));

	var args = ['release', 'create', 'v' + version,
		'--name', releaseTitle(version),
		'--notes-file', notesFile,
		'--use-package-registry',
		'--package-name', PACKAGE_NAME
	];
	for (var name of resolved.present) args.push(path.join(dir, name));

	try {
		// Captured, not inherited. Inheriting shows the upload progress live and
		// leaves nothing to read when it fails, which is how the duplicate-asset
		// case below arrived as a bare "Command failed" with the actual reason
		// printed somewhere this code could not see. The step takes seconds;
		// live progress is not worth being unable to explain a failure.
		execFileSync('glab', args, {
			cwd: opts.cwd || process.cwd(),
			stdio: ['ignore', 'pipe', 'pipe'],
			encoding: 'utf8'
		});
	} catch (e) {
		// GitLab refuses an asset link whose name or path is already on the
		// release, so a second publish of the same version fails here rather
		// than replacing anything. Worth saying plainly: the release and its
		// notes DO get updated before the assets are attempted, so a repeat run
		// is not a no-op even though it reports a failure.
		var said = String(e.stderr || '') + String(e.stdout || '');
		if (/already been taken/i.test(said + String(e.message || e))) {
			throw new Error('the GitLab release v' + version + ' already carries these assets, so ' +
				'they were not replaced. Its name and notes have been updated.\n' +
				'  To replace the files, remove the release and publish again:\n' +
				'    glab api --method DELETE "projects/:id/releases/v' + version + '"');
		}
		throw new Error(said.trim() || e.message || String(e));
	} finally {
		try { fs.unlinkSync(notesFile); } catch (ignore) { /* best effort */ }
	}
	return resolved;
}

export {
	PACKAGE_NAME,
	remoteTag,
	parseRemoteTag,
	releaseTitle,
	releaseDescription,
	releaseAssets,
	resolveAssets,
	gitlabAvailable,
	publishToGitLab
};
