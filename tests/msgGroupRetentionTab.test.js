// tests/msgGroupRetentionTab.test.js: message group retention lives on its own
// Retention tab, in both the new-group and edit-group dialogs.
//
// Message areas and file groups have a Retention tab; message groups had the
// two fields mixed in among the Main tab's dropdowns, where a sysop looking
// for retention on the group did not find them.

import assert from 'assert';
import fs from 'fs';

function paneOf(src, fieldId) {
	var at = src.indexOf("#" + fieldId + ".form-control");
	assert.ok(at !== -1, fieldId + ' is in the view');
	var before = src.slice(0, at);
	var m = before.match(/\.tab-pane[^\n]*#(\w+)\(role='tabpanel'\)(?![\s\S]*\.tab-pane)/);
	return m ? m[1] : null;
}

describe('message group retention is on a Retention tab', function () {
	var cases = [
		{ file: 'src/views/admin/msgGroups/view.pug', pane: 'eg_tab_retention', fields: ['edit_max_age_days', 'edit_max_messages'] },
		{ file: 'src/views/admin/msgGroups/index.pug', pane: 'ng_tab_retention', fields: ['ng_max_age_days', 'ng_max_messages'] }
	];
	for (var c of cases) {
		(function (c) {
			it(c.file + ': a Retention tab, holding both fields', function () {
				var src = fs.readFileSync(c.file, 'utf8');
				assert.match(src, new RegExp("data-bs-target='#" + c.pane + "'\\) Retention"));
				for (var f of c.fields) assert.strictEqual(paneOf(src, f), c.pane, f);
			});
		})(c);
	}
});
