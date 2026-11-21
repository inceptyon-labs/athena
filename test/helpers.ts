import type { Gate } from '../src/server';

/** A Plex server that lets every token in, as its owner. */
export const anyone: Gate = {
	machineIdentifier: async () => 'machine-1',
	viewer: async () => ({ id: 'owner', name: 'Owner', owner: true }),
};

/** A Plex server and plex.tv that know two accounts: the server's owner and a friend it is shared with. */
export function fakePlex(status = 401) {
	let calls = 0;
	const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
		const path = new URL(String(url)).pathname;
		if (path === '/identity') return Response.json({ MediaContainer: { machineIdentifier: 'machine-1' } });
		const token = new Headers(init?.headers).get('X-Plex-Token');
		if (path === '/api/v2/user') {
			if (token === 'owner-token') return Response.json({ uuid: 'owner-id', username: 'owner', title: 'Owner' });
			if (token === 'friend-token') return Response.json({ uuid: 'friend-id', username: 'friend', title: 'Friend' });
			if (token === 'stranger') return Response.json({ uuid: 'stranger-id', username: 'stranger' });
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
	return { fetcher, calls: () => calls };
}
