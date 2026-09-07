for (const button of document.querySelectorAll('.copy')) {
  button.addEventListener('click', async () => {
    const code = button.parentElement.querySelector('code');
    const status = document.querySelector('#copy-status');
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.textContent = 'Copied';
      status.textContent = 'Command copied to clipboard.';
      setTimeout(() => { button.textContent = 'Copy'; }, 2000);
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(code);
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent = 'Clipboard unavailable. The command is selected; copy it with your keyboard.';
    }
  });
}
