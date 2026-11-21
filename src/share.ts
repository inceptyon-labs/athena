import { encode } from 'uqr';

/** Athena's address as friends reach it, tidied, or null unless it is a plain https:// address Ithaca will take. */
export function publicAddress(input: string): string | null {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
	return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * The link that opens Ithaca and fills in Athena's address. Ithaca's contract: scheme `ithaca`, host `athena`, one
 * query item `url` holding an https address, nothing else.
 */
export function shareLink(address: string): string {
	return `ithaca://athena?url=${encodeURIComponent(address)}`;
}

/** A QR code of `text` as SVG: black on white whatever the page's theme, which cameras read best. */
export function qrSVG(text: string): string {
	const { size, data } = encode(text, { ecc: 'M', border: 4 });
	let path = '';
	data.forEach((row, y) => {
		for (let x = 0; x < size; x++) {
			if (!row[x]) continue;
			let run = 1;
			while (row[x + run]) run++;
			path += `M${x} ${y}h${run}v1h-${run}z`;
			x += run;
		}
	});
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" ` +
		`role="img" aria-label="QR code that opens Ithaca with this address"><rect width="${size}" height="${size}" fill="#fff"/>` +
		`<path d="${path}" fill="#000"/></svg>`
	);
}
