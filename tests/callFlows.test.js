// tests/callFlows.test.js — Unit tests for call flow helpers
//
// Tests pure functions that don't require DB. No Redis, no PG.

import assert from 'assert';
import { getAvailableStages, getDefaultFlows, getDefaultPools } from '../src/models/callFlows.js';

describe('callFlows', function () {

	describe('getAvailableStages', function () {
		it('should return an array of stage definitions', function () {
			var stages = getAvailableStages();
			assert.ok(Array.isArray(stages));
			assert.ok(stages.length > 0);
		});

		it('should include required stage properties', function () {
			var stages = getAvailableStages();
			for (var s of stages) {
				assert.ok(s.name, 'stage should have name');
				assert.ok(s.label, 'stage should have label');
				assert.ok(typeof s.system === 'boolean', 'stage should have boolean system flag');
			}
		});

		it('should include core stages', function () {
			var stages = getAvailableStages();
			var names = stages.map(function(s) { return s.name; });
			assert.ok(names.includes('negotiate'), 'should include negotiate');
			assert.ok(names.includes('logon'), 'should include logon');
			assert.ok(names.includes('menu'), 'should include menu');
			assert.ok(names.includes('goodbye'), 'should include goodbye');
			assert.ok(names.includes('displayScreen'), 'should include displayScreen');
		});

		it('should mark displayScreen as needing an arg', function () {
			var stages = getAvailableStages();
			var ds = stages.find(function(s) { return s.name === 'displayScreen'; });
			assert.ok(ds);
			assert.strictEqual(ds.needsArg, true);
		});
	});

	describe('getDefaultFlows', function () {
		it('should return default flow definitions', function () {
			var flows = getDefaultFlows();
			assert.ok(Array.isArray(flows));
			assert.ok(flows.length >= 3); // Standard, Doorserver, WebDoor
		});

		it('should include Standard flow with expected stages', function () {
			var flows = getDefaultFlows();
			var standard = flows.find(function(f) { return f.name === 'Standard'; });
			assert.ok(standard, 'Standard flow should exist');
			assert.ok(standard.is_system, 'Standard should be a system flow');
			assert.ok(Array.isArray(standard.stages));
			var stageNames = standard.stages.map(function(s) { return s.stage; });
			assert.ok(stageNames.includes('negotiate'));
			assert.ok(stageNames.includes('logon'));
			assert.ok(stageNames.includes('menu'));
			assert.ok(stageNames.includes('goodbye'));
		});

		it('should include Doorserver flow', function () {
			var flows = getDefaultFlows();
			var ds = flows.find(function(f) { return f.name === 'Doorserver'; });
			assert.ok(ds);
			var stageNames = ds.stages.map(function(s) { return s.stage; });
			assert.ok(stageNames.includes('door_auth'));
			assert.ok(stageNames.includes('door_launch'));
			assert.ok(stageNames.includes('goodbye'));
		});

		it('should include WebDoor flow', function () {
			var flows = getDefaultFlows();
			var wd = flows.find(function(f) { return f.name === 'WebDoor'; });
			assert.ok(wd);
			var stageNames = wd.stages.map(function(s) { return s.stage; });
			assert.ok(stageNames.includes('webdoor_auth'));
			assert.ok(stageNames.includes('goodbye'));
		});
	});

	describe('getDefaultPools', function () {
		it('should return default pool definitions', function () {
			var pools = getDefaultPools();
			assert.ok(Array.isArray(pools));
			assert.ok(pools.length >= 3);
		});

		it('should map PrimaryBBS to Standard flow', function () {
			var pools = getDefaultPools();
			var primary = pools.find(function(p) { return p.name === 'PrimaryBBS'; });
			assert.ok(primary);
			assert.strictEqual(primary.flow_name, 'Standard');
			assert.ok(primary.is_system);
		});

		it('should have WebSocket paths on pools', function () {
			var pools = getDefaultPools();
			var primary = pools.find(function(p) { return p.name === 'PrimaryBBS'; });
			assert.ok(Array.isArray(primary.ws_paths));
			assert.ok(primary.ws_paths.includes('/'));
		});
	});
});
