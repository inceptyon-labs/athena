import { Audiobookshelf } from '../src/abs';
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

/**
 * An Audiobookshelf with one book library: a numbered book Audible names (`dune`), a numbered book whose chapters
 * break elsewhere (`emma`), a book with names already (`ivanhoe`) and one without an ASIN (`odd`). Saving chapters
 * changes the book but not its `updatedAt`. `writes` counts saves, `lookups` Audible lookups, `fetched` book reads.
 */
export function fakeAbs(duringLookup: (books: Record<string, unknown>) => void = () => {}) {
	let writes = 0;
	let lookups = 0;
	let fetched = 0;
	type Chapter = { id: number; start: number; end: number; title: string };
	type Book = { id: string; updatedAt: number; media: { duration: number; chapters: Chapter[]; metadata: Record<string, unknown> } };
	const numbered = (count: number, length: number) =>
		Array.from({ length: count }, (_, index) => ({
			id: index,
			start: (index * length) / count,
			end: ((index + 1) * length) / count,
			title: `Chapter ${index + 1}`,
		}));
	const books: Record<string, Book> = {
		dune: { id: 'dune', updatedAt: 1, media: { duration: 1000, chapters: numbered(2, 1000), metadata: { title: 'Dune', asin: 'B001' } } },
		emma: { id: 'emma', updatedAt: 1, media: { duration: 1000, chapters: numbered(2, 1000), metadata: { title: 'Emma', asin: 'B002' } } },
		ivanhoe: {
			id: 'ivanhoe',
			updatedAt: 1,
			media: {
				duration: 1000,
				chapters: [
					{ id: 0, start: 0, end: 500, title: 'The Forest' },
					{ id: 1, start: 500, end: 1000, title: 'The Tournament' },
				],
				metadata: { title: 'Ivanhoe', asin: 'B003' },
			},
		},
	};
	const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
		if (new Headers(init?.headers).get('Authorization') !== 'Bearer abs-key') return new Response('', { status: 401 });
		const target = new URL(String(url));
		const path = target.pathname;
		const saving = path.match(/^\/api\/items\/(\w+)\/chapters$/)?.[1];
		if (saving && init?.method === 'POST') {
			const book = books[saving];
			if (!book) return new Response('', { status: 404 });
			writes += 1;
			// Like Audiobookshelf's chapter endpoint, this saves the book's media, not the item: `updatedAt` stays.
			book.media.chapters = (JSON.parse(String(init.body)) as { chapters: Chapter[] }).chapters;
			return Response.json({ success: true, updated: true });
		}
		if (path === '/api/me') return Response.json({ id: 'u1', username: 'jason', type: 'root' });
		if (path === '/api/libraries')
			return Response.json({
				libraries: [
					{ id: 'books', name: 'Books', mediaType: 'book' },
					{ id: 'pods', name: 'Podcasts', mediaType: 'podcast' },
				],
			});
		if (path === '/api/libraries/books/items')
			return Response.json({
				total: Object.keys(books).length + 1,
				results: [
					...Object.values(books).map((book) => ({
						id: book.id,
						updatedAt: book.updatedAt,
						media: { duration: book.media.duration, numChapters: book.media.chapters.length, metadata: book.media.metadata },
					})),
					{ id: 'odd', updatedAt: 1, media: { duration: 1000, numChapters: 2, metadata: { title: 'Odd', asin: null } } },
				],
			});
		const item = path.match(/^\/api\/items\/(\w+)$/)?.[1];
		if (item && books[item]) {
			fetched += 1;
			return Response.json(books[item]);
		}
		if (path === '/api/search/chapters') {
			lookups += 1;
			duringLookup(books);
			const asin = target.searchParams.get('asin');
			if (asin === 'B001')
				return Response.json({
					chapters: [
						{ startOffsetMs: 0, lengthMs: 500_000, title: 'Book One: Dune' },
						{ startOffsetMs: 500_000, lengthMs: 500_000, title: 'Book Two: Muad’Dib' },
					],
					runtimeLengthMs: 1_000_000,
				});
			if (asin === 'B002')
				return Response.json({
					chapters: [
						{ startOffsetMs: 0, lengthMs: 300_000, title: 'Volume I' },
						{ startOffsetMs: 300_000, lengthMs: 700_000, title: 'Volume II' },
					],
					runtimeLengthMs: 1_000_000,
				});
			return Response.json({ error: 'Chapters not found' });
		}
		return new Response('', { status: 404 });
	}) as typeof fetch;
	return {
		abs: new Audiobookshelf('http://abs:13378', 'abs-key', fetcher),
		fetcher,
		books,
		writes: () => writes,
		lookups: () => lookups,
		fetched: () => fetched,
	};
}
