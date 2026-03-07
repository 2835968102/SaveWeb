console.log('Background service worker running!');

// Fetch a remote resource on behalf of the popup.
// The background service worker has <all_urls> host_permissions so it can
// bypass CORS restrictions that would block the popup/content-script.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== 'fetchResource') return false;

  const { url, asText } = request;

  fetch(url)
    .then(async (response) => {
      const contentType = response.headers.get('content-type') || '';
      if (!response.ok) {
        sendResponse({ success: false, error: `HTTP ${response.status}` });
        return;
      }

      // Return CSS / plain-text resources as UTF-8 strings to avoid base64 overhead
      const isText =
        asText ||
        contentType.startsWith('text/') ||
        contentType.includes('javascript') ||
        contentType.includes('json') ||
        contentType.includes('xml');

      if (isText) {
        const text = await response.text();
        sendResponse({ success: true, text, contentType });
      } else {
        // Binary resource (images, fonts, …) — send as base64
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        // Process in chunks to avoid call-stack overflow
        const CHUNK = 8192;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        const base64 = btoa(binary);
        sendResponse({ success: true, base64, contentType });
      }
    })
    .catch((err) => sendResponse({ success: false, error: err.message }));

  return true; // keep the message channel open for the async response
});
