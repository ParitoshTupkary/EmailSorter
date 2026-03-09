// background.js — service worker
// Handles messages from content.js: fetches API key from storage, calls Groq API

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // content.js asks: "give me the API key"
  if (msg.action === 'getApiKey') {
    chrome.storage.local.get(['anthropic_api_key'], (data) => {
      sendResponse({ key: data['anthropic_api_key'] || null });
    });
    return true;
  }

  // content.js asks: "call Groq with these emails"
  if (msg.action === 'callGemini') {
    chrome.storage.local.get(['anthropic_api_key'], async (data) => {
      const apiKey = data['anthropic_api_key'];
      if (!apiKey) {
        sendResponse({ error: 'No API key saved' });
        return;
      }

      try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            temperature: 0.1,
            messages: [{ role: 'user', content: msg.prompt }]
          })
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          sendResponse({ error: err?.error?.message || `API ${res.status}` });
          return;
        }

        const data2 = await res.json();
        const text = data2.choices?.[0]?.message?.content || '[]';
        sendResponse({ result: text });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    });
    return true;
  }

  // popup asks: "force sort on webmail tab"
  if (msg.action === 'forceSort') {
    chrome.tabs.query({ url: 'https://webmail.iitb.ac.in/*' }, (tabs) => {
      if (tabs && tabs.length > 0) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'forceSort' });
      }
    });
    return false;
  }

});
