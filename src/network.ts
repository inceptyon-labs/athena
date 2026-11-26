/**
 * Whether an address is on a home network rather than the internet: loopback, the private IPv4 ranges, link-local,
 * 100.64.0.0/10 (which Tailscale and other VPNs hand out), and IPv6 unique-local and link-local addresses.
 */
export function homeAddress(address: string | null | undefined): boolean {
	if (!address) return false;
	let ip = address.trim().toLowerCase();
	if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
	ip = ip.split('%')[0] ?? '';
	ip = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)?.[1] ?? ip;
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
	if (v4) {
		const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
		if (a > 255 || b > 255 || c > 255 || d > 255) return false;
		return (
			a === 10 ||
			a === 127 ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 169 && b === 254) ||
			(a === 100 && b >= 64 && b <= 127)
		);
	}
	if (!/^[0-9a-f:]+$/.test(ip) || !ip.includes(':')) return false;
	if (ip === '::1') return true;
	const first = ip.startsWith(':') ? 0 : Number.parseInt(ip.split(':')[0] as string, 16);
	return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/**
 * The addresses a request says it was forwarded for, by the headers proxies and tunnels add: Cloudflare's
 * `Cf-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP` and `Forwarded`. Empty for a request no proxy passed on.
 */
export function forwardedFor(header: (name: string) => string | undefined): string[] {
	const found: string[] = [];
	for (const name of ['Cf-Connecting-IP', 'X-Real-IP']) {
		const value = header(name)?.trim();
		if (value) found.push(value);
	}
	for (const each of header('X-Forwarded-For')?.split(',') ?? []) if (each.trim()) found.push(each.trim());
	for (const match of header('Forwarded')?.matchAll(/for="?([^";,]+)"?/gi) ?? []) found.push((match[1] as string).trim());
	return found;
}
