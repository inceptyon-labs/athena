// Two bits of script. Settings' Test key button, which asks Athena to check the key against the chosen model:
const button = document.querySelector('[data-test-key]');
if (button) {
	const form = button.closest('form');
	const output = form.querySelector('.test-result');
	button.hidden = false;
	button.addEventListener('click', async () => {
		const body = new FormData();
		const key = form.elements.namedItem('anthropicKey');
		const model = form.elements.namedItem('model');
		if (key && 'value' in key) body.set('anthropicKey', key.value);
		if (model && 'value' in model) body.set('model', model.value);
		button.disabled = true;
		button.textContent = 'Testing…';
		output.className = 'test-result';
		output.textContent = '';
		try {
			const response = await fetch('/settings/test', { method: 'POST', body });
			const answer = await response.json();
			output.textContent = answer.message;
			output.classList.add(answer.ok ? 'ok' : 'bad');
		} catch {
			output.textContent = "Couldn't reach Athena.";
			output.classList.add('bad');
		} finally {
			button.disabled = false;
			button.textContent = 'Test key';
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
