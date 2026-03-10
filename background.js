console.log('Background service worker running!');

// Fetch a remote resource on behalf of the popup.
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
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const CHUNK = 8192;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        const base64 = btoa(binary);
        sendResponse({ success: true, base64, contentType });
      }
    })
    .catch((err) => sendResponse({ success: false, error: err.message }));

  return true;
});

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

// Helper: Download content using a data URL (service workers lack URL.createObjectURL)
async function downloadBlob(content, filename, mimeType) {
  let bytes;
  if (typeof content === 'string') {
    bytes = new TextEncoder().encode(content);
  } else {
    const buffer = content instanceof ArrayBuffer ? content : await content.arrayBuffer();
    bytes = new Uint8Array(buffer);
  }

  // Convert bytes to base64 in chunks to avoid call stack limits
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  const dataUrl = `data:${mimeType};base64,${btoa(binary)}`;

  await new Promise((resolve, reject) => {
    chrome.downloads.download({ url: dataUrl, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(downloadId);
    });
  });
}

// Auto-save page
async function autoSavePage(tabId, url, title) {
  console.log('=== Auto-save triggered ===', tabId, url);

  // Inject required libraries
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      files: ['Readability.js', 'turndown.js', 'turndown-plugin-gfm.js']
    });
  } catch (err) {
    console.error('❌ Failed to inject scripts:', err);
    return;
  }

  const timestamp = getTimestamp();
  let baseFilename = safeFilename(title);

  // --- Step 1: Save Markdown (fast, no network requests) ---
  try {
    const mdResults = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: () => {
        try {
          for (const b of document.head.querySelectorAll('base')) b.remove();
          const pageHtml = document.documentElement.outerHTML;
          const pageTitle = document.title || 'Untitled';
          const pageUrl = window.location.href;

          const parser = new DOMParser();
          const dom = parser.parseFromString(pageHtml, 'text/html');
          let content;
          let articleTitle = pageTitle;
          try {
            const article = new Readability(dom).parse();
            if (article && article.content) {
              content = article.content;
              if (article.title) articleTitle = article.title;
            } else {
              content = dom.body.innerHTML;
            }
          } catch (e) {
            content = dom.body.innerHTML;
          }

          const turndownService = new TurndownService({
            headingStyle: 'atx',
            hr: '---',
            bulletListMarker: '-',
            codeBlockStyle: 'fenced',
            emDelimiter: '_',
            linkStyle: 'inlined',
            linkReferenceStyle: 'full'
          });
          turndownService.use(turndownPluginGfm.gfm);
          turndownService.keep(['sub', 'sup', 'u', 'ins', 'del', 'small', 'big']);
          const markdown = turndownService.turndown(content);

          const frontmatter =
            '---\n' +
            'title: ' + articleTitle.replace(/:/g, '&#58;') + '\n' +
            'source: ' + pageUrl + '\n' +
            '---\n\n';

          return { success: true, markdown: frontmatter + markdown, title: articleTitle };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }
    });

    const mdRes = mdResults[0];
    if (mdRes?.result?.success) {
      baseFilename = safeFilename(mdRes.result.title);
      const mdFilename = `save_as_markdown/${baseFilename}_${timestamp}.md`;
      await downloadBlob(mdRes.result.markdown, mdFilename, 'text/markdown');
      console.log('✅ Saved Markdown:', mdFilename);
    } else {
      console.error('❌ Markdown failed:', mdRes?.result?.error, mdRes?.error);
    }
  } catch (err) {
    console.error('❌ Markdown step threw:', err);
  }

  // --- Step 2: Save HTML (slow, inlines all resources) ---
  try {
    const htmlResults = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: async () => {
        try {
          async function toDataUri(url) {
            try {
              const resp = await chrome.runtime.sendMessage({ action: 'fetchResource', url, asText: false });
              if (!resp.success) throw new Error(resp.error);
              const mimeType = (resp.contentType || 'application/octet-stream').split(';')[0].trim();
              if (resp.base64) return `data:${mimeType};base64,${resp.base64}`;
              if (resp.text !== undefined) {
                const b64 = btoa(unescape(encodeURIComponent(resp.text)));
                return `data:${mimeType};base64,${b64}`;
              }
            } catch (e) {
              console.warn('toDataUri failed for', url, e);
            }
            return url;
          }

          async function inlineCssUrls(cssText, cssBaseUrl) {
            const re = /url\(\s*(['"]?)([^)'"]+)\1\s*\)/g;
            const matches = [];
            let m;
            while ((m = re.exec(cssText)) !== null) {
              const raw = m[2].trim();
              if (raw.startsWith('data:') || raw.startsWith('#')) continue;
              try { matches.push({ token: m[0], quote: m[1], abs: new URL(raw, cssBaseUrl).href }); } catch (e) {}
            }
            for (const { token, quote, abs } of matches) {
              const dataUri = await toDataUri(abs);
              cssText = cssText.split(token).join(`url(${quote}${dataUri}${quote})`);
            }
            return cssText;
          }

          async function fullyCssProcess(cssText, cssBaseUrl) {
            const importRe = /@import\s+(?:url\(\s*['"]?([^)'"]+)['"]?\s*\)|['"]([^'"]+)['"])[^;]*;/g;
            const imports = [];
            let m;
            while ((m = importRe.exec(cssText)) !== null) {
              const raw = (m[1] || m[2]).trim();
              if (!raw.startsWith('data:')) {
                try { imports.push({ token: m[0], abs: new URL(raw, cssBaseUrl).href }); } catch (e) {}
              }
            }
            for (const { token, abs } of imports) {
              try {
                const resp = await chrome.runtime.sendMessage({ action: 'fetchResource', url: abs, asText: true });
                if (!resp.success) throw new Error(resp.error);
                cssText = cssText.split(token).join(await fullyCssProcess(resp.text, abs));
              } catch (e) {
                console.warn('Failed to inline @import:', abs, e);
              }
            }
            return await inlineCssUrls(cssText, cssBaseUrl);
          }

          for (const b of document.head.querySelectorAll('base')) b.remove();
          if (document.head.getElementsByTagName('title').length === 0) {
            const t = document.createElement('title');
            t.innerText = document.title;
            document.head.append(t);
          }
          const pageHtml = document.documentElement.outerHTML;
          const pageUrl = window.location.href;
          const pageTitle = document.title || 'Untitled';

          const parser = new DOMParser();
          const doc = parser.parseFromString(pageHtml, 'text/html');
          const base = doc.createElement('base');
          base.setAttribute('href', pageUrl);
          doc.head.prepend(base);

          // Inline external stylesheets
          for (const link of Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]'))) {
            const href = link.getAttribute('href');
            if (!href || href.startsWith('data:')) continue;
            try {
              const absUrl = new URL(href, pageUrl).href;
              const resp = await chrome.runtime.sendMessage({ action: 'fetchResource', url: absUrl, asText: true });
              if (!resp.success) throw new Error(resp.error);
              const style = doc.createElement('style');
              style.textContent = await fullyCssProcess(resp.text, absUrl);
              if (link.getAttribute('media')) style.setAttribute('media', link.getAttribute('media'));
              link.parentNode.replaceChild(style, link);
            } catch (e) {
              console.warn('Skipped stylesheet:', href, e);
            }
          }

          // Process inline style blocks
          for (const style of Array.from(doc.querySelectorAll('style'))) {
            style.textContent = await inlineCssUrls(style.textContent, pageUrl);
          }

          // Inline images
          for (const img of Array.from(doc.querySelectorAll('img[src]'))) {
            const src = img.getAttribute('src');
            if (!src || src.startsWith('data:')) continue;
            try { img.setAttribute('src', await toDataUri(new URL(src, pageUrl).href)); } catch (e) {}
            img.removeAttribute('srcset');
            img.removeAttribute('loading');
            img.removeAttribute('decoding');
          }

          // Inline source elements
          for (const src_el of Array.from(doc.querySelectorAll('source[src]'))) {
            const src = src_el.getAttribute('src');
            if (!src || src.startsWith('data:')) continue;
            try { src_el.setAttribute('src', await toDataUri(new URL(src, pageUrl).href)); } catch (e) {}
            src_el.removeAttribute('srcset');
          }

          // Rewrite links to absolute URLs
          for (const a of doc.querySelectorAll('a[href]')) {
            const href = a.getAttribute('href');
            if (!href) continue;
            if (href.startsWith('#') || href.startsWith('data:') ||
                href.startsWith('mailto:') || href.startsWith('javascript:') || href.startsWith('tel:')) continue;
            try { a.setAttribute('href', new URL(href, pageUrl).href); } catch (e) {}
          }

          return { success: true, html: '<!DOCTYPE html>\n' + doc.documentElement.outerHTML, title: pageTitle };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }
    });

    const htmlRes = htmlResults[0];
    if (htmlRes?.result?.success) {
      const htmlFilename = `save_as_html/${baseFilename}_${timestamp}.html`;
      await downloadBlob(htmlRes.result.html, htmlFilename, 'text/html');
      console.log('✅ Saved HTML:', htmlFilename);
    } else {
      console.error('❌ HTML failed:', htmlRes?.result?.error, htmlRes?.error);
    }
  } catch (err) {
    console.error('❌ HTML step threw:', err);
  }
}

// Dedup: track recently triggered saves to avoid double-save on same URL
const recentlySaved = new Map(); // url -> timestamp

// Listen to tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.startsWith('http')) {
    const now = Date.now();
    const lastSaved = recentlySaved.get(tab.url);
    if (lastSaved && now - lastSaved < 10000) {
      console.log('Skipping duplicate save for:', tab.url);
      return;
    }
    recentlySaved.set(tab.url, now);
    // Clean up old entries
    for (const [url, time] of recentlySaved) {
      if (now - time > 60000) recentlySaved.delete(url);
    }

    console.log('Tab complete, waiting 3s before auto-save...');
    setTimeout(() => {
      autoSavePage(tabId, tab.url, tab.title);
    }, 3000);
  }
});
