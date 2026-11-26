// Two bits of script. Settings' Test button, which asks Athena to check the chosen provider's key, or the local
// server, against the chosen model, and offers a local server's models in its Model field:
const button = document.querySelector('[data-test-key]');
if (button) {
	const form = button.closest('form');
	const output = button.parentElement.querySelector('.test-result');
	const value = (name) => {
		const field = form.elements.namedItem(name);
		return field && 'value' in field ? field.value : '';
	};
	button.hidden = false;
	button.addEventListener('click', async () => {
		const provider = form.querySelector('input[name="provider"]:checked')?.value ?? '';
		const body = new FormData();
		body.set('_token', value('_token'));
		body.set('provider', provider);
		body.set(`${provider}Key`, value(`${provider}Key`));
		body.set('model', value(`model_${provider}`));
		body.set('localURL', value('localURL'));
		button.disabled = true;
		button.textContent = 'Testing…';
		output.className = 'test-result';
		output.textContent = '';
		try {
			const response = await fetch('/settings/test', { method: 'POST', body });
			const answer = await response.json();
			output.textContent = answer.message;
			output.classList.add(answer.ok ? 'ok' : 'bad');
			const list = document.getElementById('local-models');
			if (list && answer.models) list.replaceChildren(...answer.models.map((name) => new Option(name)));
		} catch {
			output.textContent = "Couldn't reach Athena.";
			output.classList.add('bad');
		} finally {
			button.disabled = false;
			button.textContent = 'Test';
		}
	});
	// A result is about the provider it tested.
	form.addEventListener('change', (event) => {
		if (event.target.name === 'provider') {
			output.className = 'test-result';
			output.textContent = '';
		}
	});
}

// Settings' Audiobookshelf Test: signs in with the address and key typed above, before they're saved.
const absButton = document.querySelector('[data-test-abs]');
if (absButton) {
	const form = absButton.closest('form');
	const output = absButton.parentElement.querySelector('.test-result');
	const value = (name) => {
		const field = form.elements.namedItem(name);
		return field && 'value' in field ? field.value : '';
	};
	absButton.hidden = false;
	absButton.addEventListener('click', async () => {
		const body = new FormData();
		body.set('_token', value('_token'));
		body.set('absURL', value('absURL'));
		body.set('absKey', value('absKey'));
		absButton.disabled = true;
		absButton.textContent = 'Testing…';
		output.className = 'test-result';
		output.textContent = '';
		try {
			const response = await fetch('/settings/test-abs', { method: 'POST', body });
			const answer = await response.json();
			output.textContent = answer.message;
			output.classList.add(answer.ok ? 'ok' : 'bad');
		} catch {
			output.textContent = "Couldn't reach Athena.";
			output.classList.add('bad');
		} finally {
			absButton.disabled = false;
			absButton.textContent = 'Test';
		}
	});
}

// Share's Copy button. The clipboard API needs HTTPS, which Athena at home doesn't have, so it falls back to selecting
// the text and copying that.
for (const copy of document.querySelectorAll('[data-copy]')) {
	const field = document.getElementById(copy.dataset.copy);
	copy.hidden = false;
	copy.addEventListener('click', async () => {
		let copied = false;
		try {
			await navigator.clipboard.writeText(field.value);
			copied = true;
		} catch {
			field.select();
			copied = document.execCommand('copy');
		}
		copy.textContent = copied ? 'Copied' : 'Selected';
		setTimeout(() => (copy.textContent = 'Copy'), 2000);
	});
}
