const STORAGE_KEY = 'anthropic_api_key';
const INTERVAL_KEY = 'sort_interval_mins';

const apiKeyInput = document.getElementById('apiKey');
const intervalSelect = document.getElementById('interval');
const saveBtn = document.getElementById('saveBtn');
const status = document.getElementById('status');

chrome.storage.local.get([STORAGE_KEY, INTERVAL_KEY], (data) => {
  if (data[STORAGE_KEY]) {
    apiKeyInput.value = data[STORAGE_KEY];
    status.textContent = '✓ Key saved — sorter is active on webmail';
    status.className = 'status ok';
  }
  if (data[INTERVAL_KEY]) {
    intervalSelect.value = data[INTERVAL_KEY];
  }
});

saveBtn.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  const interval = intervalSelect.value;

  if (!key || key.length < 10) {
    status.textContent = '✗ Paste your full Gemini API key';
    status.className = 'status err';
    return;
  }

  chrome.storage.local.set({ [STORAGE_KEY]: key, [INTERVAL_KEY]: interval }, () => {
    status.textContent = '✓ Saved! Triggering sort...';
    status.className = 'status ok';
    chrome.runtime.sendMessage({ action: 'forceSort' }, () => {
      void chrome.runtime.lastError;
      status.textContent = '✓ Saved & sorting now!';
    });
  });
});
