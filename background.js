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

// --- Auto-save functionality ---

// Helper: Safe filename
function safeFilename(title) {
  return (
    (title || 'Page')
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 100) || 'Page'
  );
}

// Helper: Get timestamp (YYYYMMDD-HHMMSS)
function getTimestamp() {
  const now = new Date();
  return now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') + '-' +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');
}

// Helper: Download content using data URI (works in Service Workers)
async function downloadBlob(content, filename, mimeType) {
  // Convert content to base64 for data URI
  let base64;
  if (typeof content === 'string') {
    base64 = btoa(unescape(encodeURIComponent(content)));
  } else {
    // If content is a Blob or ArrayBuffer, convert to base64
    const buffer = content instanceof Blob ? await content.arrayBuffer() : content;
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    base64 = btoa(binary);
  }

  const dataUrl = `data:${mimeType};base64,${base64}`;
  
  await new Promise((resolve, reject) => {
    chrome.downloads.download({ 
      url: dataUrl, 
      filename: `save_markdown/${filename}`, 
      saveAs: false 
    }, (downloadId) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(downloadId);
    });
  });
}

// Helper: Send message to content script with retries
async function sendMessageWithRetry(tabId, message, maxRetries = 3, delayMs = 500) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      console.log(`Sending message to tab ${tabId} (attempt ${i+1}/${maxRetries})`);
      const response = await chrome.tabs.sendMessage(tabId, message);
      return response;
    } catch (err) {
      console.warn(`Attempt ${i+1} failed:`, err);
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw new Error('Failed to send message after multiple retries');
}

// Auto-save page as Markdown when page loads
async function autoSavePage(tabId, url, title) {
  try {
    console.log('=== Auto-save triggered ===');
    console.log('Tab ID:', tabId);
    console.log('URL:', url);
    console.log('Title:', title);

    // Send message to content script to process the page
    const response = await sendMessageWithRetry(tabId, { action: 'processPage' });

    if (!response || !response.success) {
      console.error('❌ Content script failed:', response?.error);
      return;
    }

    console.log('✅ Received Markdown from content script');

    // Save to Downloads/save_markdown/
    const filename = `${safeFilename(response.title)}_${getTimestamp()}.md`;
    console.log('Saving to:', `save_markdown/${filename}`);
    await downloadBlob(response.markdown, filename, 'text/markdown');
    console.log('✅ Auto-saved page:', filename);

  } catch (err) {
    console.error('❌ Auto-save failed:', err);
  }
}

// Listen to tab updates to trigger auto-save
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Only auto-save when page finishes loading, and URL is HTTP/HTTPS
  if (changeInfo.status === 'complete' && tab.url && tab.url.startsWith('http')) {
    // Add a small delay to ensure page is fully rendered and content script is ready
    setTimeout(() => {
      autoSavePage(tabId, tab.url, tab.title);
    }, 1500);
  }
});
