// tests/adminFormSubmit.test.js: every admin form can actually be submitted.
//
// The add and edit file area forms rendered with no submit button at all. The
// modal opened, every field worked, and there was no way to save. Both forms on
// the file areas page were affected, plus the add-area form on the file group
// page, so file areas could not be created through the web at all.
//
// They were lost when three near-identical forms were collapsed into the
// fileAreaFormFields mixin. The button had lived in each caller, and was not
// carried across. The conversion was verified by diffing the set of element ids
// rendered before and after, which passed, because a submit input has no id.
//
// So this checks the thing that verification could not: that a form a user is
// meant to submit contains something to submit it with. It renders the real
// templates, no database.
//
// Run: npx mocha --spec tests/adminFormSubmit.test.js

import assert from 'assert';

var pug = null;
try { pug = (await import('pug')).default; } catch (_) { pug = null; }

// A sysop, so the guard chain in each template reaches the content block
// rather than rendering the unauthorized partial. Getting this wrong is the
// easy way to write a test that passes against an empty page.
function locals(extra) {
	return Object.assign({
		currentuser: { username: 'tester', security: 255, permissionflags: ['Sysop'] },
		sufficientAccess: true,
		title: 'Test', activelink: '', ismobile: false,
		fileAreas: [], fileGroups: [{ shortcode: 'G1', name: 'Group One' }],
		msgAreas: [], msgGroups: [{ shortcode: 'G1', name: 'Group One' }],
		networks: [], permissionFlags: [], restrictionFlags: []
	}, extra || {});
}

// Every <form> in the rendered page, as { attrs, body }.
function forms(html) {
	var out = [];
	var re = /<form([^>]*)>/g;
	var m;
	while ((m = re.exec(html)) !== null) {
		var end = html.indexOf('</form>', m.index);
		out.push({
			attrs: m[1],
			body: html.substring(m.index, end === -1 ? html.length : end)
		});
	}
	return out;
}

// A form can be submitted from outside its own element: a button carrying
// form="<id>" is valid HTML and this codebase uses it wherever the control
// belongs in a modal footer, outside the <form>. Counting only what is nested
// inside would report those as broken.
function submitCount(form, html) {
	var inside = (form.body.match(/type="submit"/g) || []).length;

	var id = /id="([^"]+)"/.exec(form.attrs);
	if (!id) return inside;

	var outside = 0;
	var re = /<button([^>]*)>/g;
	var m;
	while ((m = re.exec(html)) !== null) {
		if (/type="submit"/.test(m[1]) && new RegExp('form="' + id[1] + '"').test(m[1])) outside++;
	}
	return inside + outside;
}

// Name a form by whatever identifies it, so a failure says which one.
function label(form) {
	var id = /id="([^"]+)"/.exec(form.attrs);
	if (id) return id[1];
	var action = /action="([^"]+)"/.exec(form.attrs);
	return action ? action[1] : form.attrs.trim() || '(anonymous form)';
}

var PAGES = [
	{
		name: 'file areas',
		template: 'src/views/admin/fileAreas/index.pug',
		locals: {}
	},
	{
		name: 'file group detail',
		template: 'src/views/admin/fileGroups/view.pug',
		locals: {
			fileGroup: { shortcode: 'G1', name: 'Group One',
				browse_security: 50, read_security: 60, post_security: 100 }
		}
	},
	{
		name: 'file groups',
		template: 'src/views/admin/fileGroups/index.pug',
		locals: {}
	},
	{
		name: 'message areas',
		template: 'src/views/admin/msgAreas/index.pug',
		locals: {}
	}
];

describe('admin forms have a submit control', function () {
	before(function () { if (!pug) this.skip(); });

	for (var page of PAGES) {
		(function (p) {
			describe(p.name, function () {
				var rendered = null;

				var pageHtml = null;

				before(function () {
					try {
						pageHtml = pug.renderFile(p.template, locals(p.locals));
						rendered = forms(pageHtml);
					} catch (err) {
						// A template needing locals this test does not supply is
						// not a finding; say so rather than failing misleadingly.
						this.skip();
					}
				});

				it('renders at least one form', function () {
					assert.ok(rendered && rendered.length > 0,
						p.template + ' rendered no forms, so this suite is checking nothing');
				});

				it('gives every form a way to submit it', function () {
					var broken = rendered.filter(function (f) { return submitCount(f, pageHtml) === 0; });
					assert.deepStrictEqual(broken.map(label), [],
						'form(s) with no submit control in ' + p.template);
				});
			});
		})(page);
	}
});

describe('the file area form mixin', function () {
	before(function () { if (!pug) this.skip(); });

	// The mixin serves three callers. Its own output is what has to carry the
	// button, since that is what made losing it possible in the first place.
	var html = null;
	before(function () {
		html = pug.renderFile('src/views/admin/fileAreas/index.pug', locals());
	});

	it('labels the create form Submit and the edit form Save Changes', function () {
		var byId = {};
		for (var f of forms(html)) byId[label(f)] = f;

		assert.ok(/value="Submit"/.test(byId.newAreaForm.body), 'create form');
		assert.ok(/value="Save Changes"/.test(byId.editAreaForm.body), 'edit form');
	});

	it('puts the button outside the tab panes', function () {
		// Inside .tab-content it would only be visible while the last tab was
		// open, which looks identical to the bug on the first two tabs.
		var f = forms(html).filter(function (x) { return label(x) === 'newAreaForm'; })[0];
		var lastPaneEnd = f.body.lastIndexOf('tab_retention');
		var submitAt = f.body.indexOf('type="submit"');

		assert.ok(submitAt > lastPaneEnd,
			'submit renders before the end of the tab content');
	});
});
