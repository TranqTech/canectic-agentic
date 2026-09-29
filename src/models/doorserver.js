// doorserver.js -- registered door-server client systems (#86).
//
// Until #86 this returned one hardcoded test BBS for ANY system id, with an
// auth token published in the repository, so anyone could log in to the
// door-server pool. Until registered systems exist (phase B), no system is
// known and every door-server login is refused.

async function getClientBBS(bbsid) {
	return null;
}

export { getClientBBS };
