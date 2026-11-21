import { expect, test } from 'bun:test';
import { publicAddress, qrSVG, shareLink } from '../src/share';

test("the share link is Ithaca's: scheme ithaca, host athena, one url item holding the https address", () => {
	for (const address of ['https://athena.example.com', 'https://example.com/athena', 'https://example.com:8443']) {
		const link = shareLink(address);
		const url = new URL(link);
		expect(url.protocol).toBe('ithaca:');
		expect(url.host).toBe('athena');
		expect([...url.searchParams.keys()]).toEqual(['url']);
		expect(url.searchParams.get('url')).toBe(address);
	}
	expect(shareLink('https://athena.example.com')).toBe('ithaca://athena?url=https%3A%2F%2Fathena.example.com');
});

test('a public address is https only, with no query, fragment or sign-in, and no trailing slash', () => {
	expect(publicAddress(' https://Athena.Example.com/ ')).toBe('https://athena.example.com');
	expect(publicAddress('https://example.com/athena/')).toBe('https://example.com/athena');
	expect(publicAddress('https://example.com:443')).toBe('https://example.com');
	for (const bad of ['http://athena.example.com', 'athena.example.com', 'https://a.example.com/?x=1', 'https://a.example.com/#x', 'https://me:pw@a.example.com', 'ithaca://athena'])
		expect(publicAddress(bad)).toBeNull();
});

test('the QR code is black on white with a quiet zone', () => {
	const svg = qrSVG(shareLink('https://athena.example.com'));
	expect(svg).toStartWith('<svg');
	expect(svg).toContain('viewBox="0 0 41 41"');
	expect(svg).toContain('fill="#fff"');
	expect(svg).toContain('M4 4h7v1h-7z');
});
