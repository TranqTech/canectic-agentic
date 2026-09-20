/**
 * The periodic outbound sweep: the safety net that pushes whatever is still
 * queued outbound, for every protocol this system carries.
 *
 * Most outbound tossing happens on demand, when a message is posted or a file
 * is uploaded.  The sweep exists for everything that misses that moment: a web
 * post made while the worker was down, a race between the import seal and the
 * export scan, a job that failed and was never retried.  For some protocols it
 * is the only thing that runs at all.
 *
 * Extracted from the worker's job switch because WHICH protocols the sweep
 * covers is a claim worth testing, and a case block inside a switch in an
 * executable cannot be reached from a test.  TIC was absent from that list for
 * its whole life: a file echo arriving from an uplink created its
 * file_distribution rows correctly and then left them at `pending` for ever,
 * because the only other things that enqueue tic:outbound are a local upload,
 * the admin button and the CLI tosser.  Nothing threw and nothing was logged,
 * so the board looked healthy while no downlink ever received a file.  That is
 * the failure this module is shaped to make visible.
 *
 * Every step is isolated.  One protocol throwing must not stop the rest, since
 * a broken QWK peer taking the sweep down would silently stop file
 * distribution as well, which is the same class of bug one layer up.
 */

/**
 * The protocols the sweep is responsible for, in the order it runs them.
 *
 * TIC runs before FTN deliberately.  `ftnTosser.TossOutbound()` enqueues a BSO
 * scan when it finishes, and the scan reads the outbound directory at the time
 * it runs; staging TIC files first means that one scan picks up the file echo
 * traffic too, rather than leaving it to the next scan or to the per-connection
 * signal TIC sends only for CRASH links.
 */
export const SWEEP_PROTOCOLS = ['tic', 'ftn', 'qwk', 'nntp', 'email'];

/**
 * Run one outbound sweep.
 *
 * Dependencies are injected rather than imported so the sequence can be tested
 * without Redis, PostgreSQL or an outbound directory.
 *
 * @param {object} deps
 * @param {object} deps.ticTosser     - needs tossOutbound()
 * @param {object} deps.ftnTosser     - needs TossOutbound()
 * @param {object} deps.qwkTosser     - needs pushToQwkPeer(uuid)
 * @param {object} deps.nntpTosser    - needs pushToNntpPeer(uuid)
 * @param {object} deps.emailTosser   - needs tossOutbound()
 * @param {object} deps.peerConnections - needs getActiveConnectionsByNetworkType(type)
 * @param {function} [deps.log]       - (level, message, colour) sink; defaults to a no-op
 * @returns {Promise<{ran: string[], errors: Array<{protocol: string, message: string}>}>}
 */
export async function runOutboundSweep(deps) {
	var {
		ticTosser, ftnTosser, qwkTosser, nntpTosser, emailTosser,
		peerConnections
	} = deps || {};

	var log = (deps && deps.log) || function () {};

	var result = { ran: [], errors: [] };

	// Record the failure against the protocol rather than rethrowing: the
	// caller wants every other protocol swept regardless.
	var step = async function (protocol, fn) {
		try {
			await fn();
			result.ran.push(protocol);
		} catch (e) {
			result.errors.push({ protocol: protocol, message: e.message });
			log(2, '[Sweep] ' + protocol + ' outbound sweep error: ' + e.message, 'yellow');
		}
	};

	// Push every active, polled connection of one network type, isolating each
	// peer so a single unreachable system does not abandon the ones after it.
	var pushEachPeer = async function (networkType, push, skip) {
		var conns = await peerConnections.getActiveConnectionsByNetworkType(networkType);
		for (var conn of (conns || [])) {
			if (!conn.poll_enabled) continue;
			if (skip && skip(conn)) continue;
			try {
				await push(conn.uuid);
			} catch (e) {
				log(3, '[Sweep] ' + networkType + ' push error (' + conn.uuid + '): ' + e.message, 'yellow');
			}
		}
	};

	for (var protocol of SWEEP_PROTOCOLS) {
		switch (protocol) {
			case 'tic':
				await step('tic', function () { return ticTosser.tossOutbound(); });
				break;

			case 'ftn':
				await step('ftn', function () { return ftnTosser.TossOutbound(); });
				break;

			case 'qwk':
				await step('qwk', function () {
					return pushEachPeer('QWK',
						function (uuid) { return qwkTosser.pushToQwkPeer(uuid); },
						// A hub-transport QWK peer is pulled from, never pushed to.
						function (conn) { return (conn.connection_data || {}).transport === 'hub'; }
					);
				});
				break;

			case 'nntp':
				await step('nntp', function () {
					return pushEachPeer('NNTP', function (uuid) { return nntpTosser.pushToNntpPeer(uuid); });
				});
				break;

			case 'email':
				await step('email', function () { return emailTosser.tossOutbound(); });
				break;
		}
	}

	return result;
}
