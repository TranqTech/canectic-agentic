// Tidies up after itself. Run only by tests/rootHooks.test.js.
describe('a test that closes what it opened', function () {
	it('passes', function () {
		clearInterval(setInterval(function () {}, 60000));
	});
});
