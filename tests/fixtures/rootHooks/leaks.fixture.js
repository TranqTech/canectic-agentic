// Leaves a timer running after its test, the way #45 did. Run only by
// tests/rootHooks.test.js, never by the suite (the spec glob is *.test.js).
describe('a test that leaks a timer', function () {
	it('passes', function () {
		setInterval(function leakedByThisFixture() {}, 60000);
	});
});
