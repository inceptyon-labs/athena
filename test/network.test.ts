import { expect, test } from 'bun:test';
import { forwardedFor, homeAddress } from '../src/network';

test('home addresses are the private, loopback, link-local and VPN ranges, nothing on the internet', () => {
	for (const home of ['192.168.1.20', '10.0.0.5', '172.18.0.4', '127.0.0.1', '169.254.3.4', '100.101.102.103', '::1', '::ffff:192.168.1.20', 'fd7a:115c:a1e0::1', 'fe80::1%eth0', '[::1]'])
		expect(homeAddress(home)).toBe(true);
	for (const away of ['203.0.113.9', '172.32.0.1', '100.128.0.1', '8.8.8.8', '2606:4700::1111', '::ffff:8.8.8.8', '192.168.1.300', 'unknown', '', null])
		expect(homeAddress(away)).toBe(false);
});

test('forwarded addresses come from every header proxies and tunnels add', () => {
	const headers: Record<string, string> = {
		'Cf-Connecting-IP': '203.0.113.7',
		'X-Forwarded-For': '192.168.1.5, 198.51.100.2',
		Forwarded: 'for=192.0.2.60;proto=https, for="[2001:db8::1]"',
	};
	expect(forwardedFor((name) => headers[name])).toEqual(['203.0.113.7', '192.168.1.5', '198.51.100.2', '192.0.2.60', '[2001:db8::1]']);
	expect(forwardedFor(() => undefined)).toEqual([]);
});
