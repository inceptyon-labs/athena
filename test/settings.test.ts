import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Live } from '../src/live';
import { DEFAULT_MODEL, mask, Settings } from '../src/settings';

const dir = () => mkdtempSync(join(tmpdir(), 'athena-'));

test('saved settings are readable only by Athena and survive a restart', () => {
	const data = dir();
	new Settings(data, {}).save({ anthropicKey: 'sk-ant-api03-secret', dailyLimit: 20 });
	expect(statSync(join(data, 'settings.json')).mode & 0o777).toBe(0o600);
	const again = new Settings(data, {}).effective();
	expect(again.anthropicKey).toBe('sk-ant-api03-secret');
	expect(again.dailyLimit).toBe(20);
	expect(again.model).toBe(DEFAULT_MODEL);
	expect(again.clientId).toMatch(/^[0-9a-f-]{36}$/);
	expect(JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8')).clientId).toBe(again.clientId);
});

test('an environment variable wins over a saved setting, and says so', () => {
	const settings = new Settings(dir(), {
		PLEX_URL: 'http://plex:32400/',
		ANTHROPIC_API_KEY: 'sk-ant-from-env',
		ATHENA_MODEL: ' ',
	});
	settings.save({ server: { id: 'machine-1', name: 'Uranus' }, anthropicKey: 'sk-ant-saved', model: 'claude-sonnet-5-5' });
	const effective = settings.effective();
	expect(effective.plexURL).toBe('http://plex:32400');
	expect(effective.server).toBeNull();
	expect(effective.anthropicKey).toBe('sk-ant-from-env');
	expect(effective.model).toBe('claude-sonnet-5-5');
	expect(effective.env).toEqual({ server: 'PLEX_URL', anthropicKey: 'ANTHROPIC_API_KEY' });
});

test('no limit is stored as none', () => {
	const settings = new Settings(dir(), {});
	settings.save({ dailyLimit: 0 });
	expect(settings.effective().dailyLimit).toBeNull();
});

test('keys show only their ends', () => {
	expect(mask('sk-ant-api03-abcdefghijklmnop-wxyz')).toBe('sk-ant-…wxyz');
	expect(mask('short')).toBe('…');
	expect(mask(null)).toBeNull();
});

test('saving applies at once: a key makes a client, a server makes a gate', () => {
	const live = new Live(new Settings(dir(), {}));
	expect(live.client).toBeNull();
	expect(live.gate).toBeNull();
	live.settings.save({ anthropicKey: 'sk-ant-test', server: { id: 'machine-1', name: 'Uranus' }, typesafeKey: 'ts' });
	live.refresh();
	expect(live.client).not.toBeNull();
	expect(live.gate).not.toBeNull();
	expect(live.jevKey).toBe('ts');
	const client = live.client;
	live.refresh();
	expect(live.client).toBe(client);
});
