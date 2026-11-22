import type { Gate } from '../src/server';

/** A Plex server that lets every token in, as its owner. */
export const anyone: Gate = {
	machineIdentifier: async () => 'machine-1',
	viewer: async () => ({ id: 'owner', name: 'Owner', owner: true }),
};

/**
 * A Plex server and plex.tv that know the server's owner (1001), a friend it is shared with (1002, a username but no
 * title) and a stranger (1003). With the owner's token, plex.tv lists who the server is shared with: the friend's token
 * for it (`friend-share`) and a managed Plex Home member's (`kid-share`, 1004, a title but no username), beside the
 * owner's own device token. `calls` counts server lists, `accounts` account lookups, `shares` share lists.
 */
export function fakePlex(status = 401) {
	let calls = 0;
	let accounts = 0;
	let shares = 0;
	const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
		const path = new URL(String(url)).pathname;
		if (path === '/identity') return Response.json({ MediaContainer: { machineIdentifier: 'machine-1' } });
		const token = new Headers(init?.headers).get('X-Plex-Token');
		if (path === '/api/servers/machine-1/access_tokens.xml') {
			shares += 1;
			if (token !== 'owner-token') return new Response('', { status });
			return new Response(
				[
					'<?xml version="1.0" encoding="UTF-8"?>',
					'<access_tokens>',
					'<access_token token="owner-device" id="77" owned="1" device="iPhone" username="owner" title="Owner"/>',
					'<access_token token="friend-share" id="1002" owned="0" username="friend" title=""/>',
					'<access_token token="kid-share" id="1004" owned="0" username="" title="Kid &amp; Co"/>',
					'</access_tokens>',
				].join('\n'),
				{ headers: { 'Content-Type': 'application/xml' } },
			);
		}
		if (path === '/api/v2/user') {
			accounts += 1;
			if (token === 'owner-token') return Response.json({ id: 1001, uuid: 'u1', username: 'owner', title: 'Owner' });
			if (token === 'friend-token') return Response.json({ id: 1002, uuid: 'u2', username: 'friend', title: '' });
			if (token === 'stranger') return Response.json({ id: 1003, uuid: 'u3', username: 'stranger' });
			return new Response('', { status });
		}
		calls += 1;
		if (token === 'owner-token')
			return Response.json([
				{ clientIdentifier: 'other-server', name: 'Other', owned: false, provides: 'server' },
				{ clientIdentifier: 'machine-1', name: 'Uranus', owned: true, provides: 'server' },
				{ clientIdentifier: 'phone', name: 'iPhone', owned: true, provides: 'client,player' },
			]);
		if (token === 'friend-token')
			return Response.json([{ clientIdentifier: 'machine-1', name: 'Uranus', owned: false, provides: 'server' }]);
		if (token === 'stranger') return Response.json([{ clientIdentifier: 'other-server', owned: true, provides: 'server' }]);
		return new Response('', { status });
	}) as typeof fetch;
	return { fetcher, calls: () => calls, accounts: () => accounts, shares: () => shares };
}
