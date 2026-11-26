import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

test('a key can come from the file its _FILE variable names, as Docker secrets and vault agents leave it', () => {
	const data = dir();
	const secret = join(data, 'typesafe');
	writeFileSync(secret, 'ts-from-file\n');
	const settings = new Settings(data, {
		TYPESAFE_API_KEY_FILE: secret,
		ANTHROPIC_API_KEY: 'sk-ant-from-env',
		ANTHROPIC_API_KEY_FILE: secret,
		ELEVENLABS_API_KEY_FILE: join(data, 'missing'),
	});
	settings.save({ typesafeKey: 'ts-saved', elevenlabsKey: 'eleven-saved' });
	const effective = settings.effective();
	expect(effective.typesafeKey).toBe('ts-from-file');
	// The variable itself wins over its file, and a file that can't be read leaves the saved key in use.
	expect(effective.anthropicKey).toBe('sk-ant-from-env');
	expect(effective.elevenlabsKey).toBe('eleven-saved');
	expect(effective.env).toEqual({ anthropicKey: 'ANTHROPIC_API_KEY', typesafeKey: 'TYPESAFE_API_KEY_FILE' });
	expect(readFileSync(join(data, 'settings.json'), 'utf8')).not.toContain('ts-from-file');
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

test('saving applies at once: a key makes a model, a server makes a gate', () => {
	const live = new Live(new Settings(dir(), {}));
	expect(live.ai).toBeNull();
	expect(live.gate).toBeNull();
	live.settings.save({ anthropicKey: 'sk-ant-test', server: { id: 'machine-1', name: 'Uranus' }, typesafeKey: 'ts' });
	live.refresh();
	expect(live.ai?.by).toBe('claude-haiku-5-5');
	expect(live.gate).not.toBeNull();
	expect(live.jevKey).toBe('ts');
});

test('the provider comes from ATHENA_PROVIDER, or the list ATHENA_MODEL is on, and each key from its own variable', () => {
	const effective = new Settings(dir(), { ATHENA_MODEL: 'gemini-4-carbon', GEMINI_API_KEY: 'g-key' }).effective();
	expect([effective.provider, effective.model, effective.env.provider]).toEqual(['gemini', 'gemini-4-carbon', 'ATHENA_MODEL']);
	expect([effective.geminiKey, effective.env.geminiKey]).toEqual(['g-key', 'GEMINI_API_KEY']);
	const local = new Settings(dir(), { ATHENA_PROVIDER: 'local' }).effective();
	expect([local.provider, local.model]).toEqual(['local', '']);
});

test("a model saved for one provider isn't used for another, which starts at its Fast tier", () => {
	const settings = new Settings(dir(), {});
	expect(settings.effective()).toMatchObject({ provider: 'anthropic', model: DEFAULT_MODEL });
	settings.save({ provider: 'openai', model: 'gpt-6.2-astra' });
	expect(settings.effective().model).toBe('gpt-6.2-astra');
	settings.save({ provider: 'xai' });
	expect(settings.effective().model).toBe('grok-4.3');
});
