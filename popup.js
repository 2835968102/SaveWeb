document.addEventListener('DOMContentLoaded', function () {
  setupButton('saveSingleFile', 'Save as Single File', saveAsSingleFile);
  setupButton('saveMd', 'Save as Markdown', saveAsMd);

  function setupButton(id, originalText, handler) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('click', async function () {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = 'Saving...';
      try {
        await handler(btn);
      } catch (err) {
        console.error(err);
        showStatus(btn, 'Error: ' + (err.message || 'Unknown error'), false);
      } finally {
        setTimeout(() => {
          btn.textContent = originalText;
          btn.disabled = false;
        }, 2000);
      }
    });
  }

  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) throw new Error('No active tab found');
    const tab = tabs[0];
    if (!tab.url || !tab.url.startsWith('http')) {
      throw new Error('Can only save HTTP or HTTPS webpages');
    }
    return tab;
  }

  function safeFilename(title, ext) {
    return (
      (title || 'Page')
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 100) || 'Page'
    ) + ext;
  }

  async function downloadBlob(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    await new Promise((resolve, reject) => {
      chrome.downloads.download({ url, filename, saveAs: true }, (downloadId) => {
        URL.revokeObjectURL(url);
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(downloadId);
      });
    });
  }

  // Serialize the live DOM from the active tab (current visual state).
  async function getPageHtml(tabId) {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        if (document.head.getElementsByTagName('title').length === 0) {
          const t = document.createElement('title');
          t.innerText = document.title;
          document.head.append(t);
        }
        // Remove any existing <base> so we can control it from the popup
        for (const b of document.head.querySelectorAll('base')) b.remove();
        return {
          html: document.documentElement.outerHTML,
          title: document.title || 'Untitled',
          url: window.location.href
        };
      }
    });
    return result[0].result;
  }

  // ── Resource fetching via background (bypasses CORS) ──────────────────────

  function fetchViaBackground(url, asText = false) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'fetchResource', url, asText }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!response || !response.success) {
          reject(new Error((response && response.error) || 'Fetch failed'));
        } else {
          resolve(response);
        }
      });
    });
  }

  // Fetch a URL and return a data URI string, or the original URL on failure.
  async function toDataUri(url) {
    try {
      const resp = await fetchViaBackground(url, false);
      const mimeType = (resp.contentType || 'application/octet-stream').split(';')[0].trim();
      if (resp.base64) {
        return `data:${mimeType};base64,${resp.base64}`;
      }
      if (resp.text !== undefined) {
        // Encode text as base64 data URI (handles UTF-8 safely)
        const b64 = btoa(unescape(encodeURIComponent(resp.text)));
        return `data:${mimeType};base64,${b64}`;
      }
    } catch (e) {
      console.warn('toDataUri failed for', url, e);
    }
    return url; // Fallback: keep original URL
  }

  // Replace all url(...) references inside CSS text with inline data URIs.
  // cssBaseUrl is the URL of the stylesheet itself (needed to resolve relative paths).
  async function inlineCssUrls(cssText, cssBaseUrl) {
    // Match url('...'), url("..."), and url(...)
    const re = /url\(\s*(['"]?)([^)'"]+)\1\s*\)/g;
    const matches = [];
    let m;
    while ((m = re.exec(cssText)) !== null) {
      const raw = m[2].trim();
      if (raw.startsWith('data:') || raw.startsWith('#')) continue;
      try {
        matches.push({ token: m[0], quote: m[1], abs: new URL(raw, cssBaseUrl).href });
      } catch (e) { /* malformed URL, skip */ }
    }
    for (const { token, quote, abs } of matches) {
      const dataUri = await toDataUri(abs);
      // Use split+join to avoid regex special-character issues in the token
      cssText = cssText.split(token).join(`url(${quote}${dataUri}${quote})`);
    }
    return cssText;
  }

  // Recursively resolve @import rules in a CSS string, then inline url() refs.
  async function fullyCssProcess(cssText, cssBaseUrl) {
    // Handle @import "url" and @import url("url")
    const importRe = /@import\s+(?:url\(\s*['"]?([^)'"]+)['"]?\s*\)|['"]([^'"]+)['"])[^;]*;/g;
    const imports = [];
    let m;
    while ((m = importRe.exec(cssText)) !== null) {
      const raw = (m[1] || m[2]).trim();
      if (!raw.startsWith('data:')) {
        try {
          imports.push({ token: m[0], abs: new URL(raw, cssBaseUrl).href });
        } catch (e) {}
      }
    }
    for (const { token, abs } of imports) {
      try {
        const resp = await fetchViaBackground(abs, true);
        let imported = await fullyCssProcess(resp.text, abs); // Recurse for nested @imports
        cssText = cssText.split(token).join(imported);
      } catch (e) {
        console.warn('Failed to inline @import:', abs, e);
      }
    }
    // Now inline all remaining url() references
    cssText = await inlineCssUrls(cssText, cssBaseUrl);
    return cssText;
  }

  // ── Save as Single File (SingleFile-inspired) ──────────────────────────────
  // Produces a self-contained HTML file that works fully offline:
  //   - External stylesheets are fetched and inlined as <style> tags
  //   - @import rules and url() font/image references inside CSS are inlined
  //   - <img src> attributes are replaced with data URIs
  //   - <a href> links are rewritten to absolute URLs
  //   - <script src> remain (optional: uncomment removal below)

  async function saveAsSingleFile(btn) {
    const tab = await getActiveTab();
    const { html, title, url: pageUrl } = await getPageHtml(tab.id);

    btn.textContent = 'Inlining CSS…';
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Pin the base URL so all relative paths resolve correctly while we work
    const base = doc.createElement('base');
    base.setAttribute('href', pageUrl);
    doc.head.prepend(base);

    // ── 1. Inline external stylesheets ────────────────────────────────────
    const linkEls = Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]'));
    for (const link of linkEls) {
      const href = link.getAttribute('href');
      if (!href || href.startsWith('data:')) continue;
      try {
        const absUrl = new URL(href, pageUrl).href;
        const resp = await fetchViaBackground(absUrl, true);
        const inlined = await fullyCssProcess(resp.text, absUrl);
        const style = doc.createElement('style');
        style.textContent = inlined;
        if (link.getAttribute('media')) style.setAttribute('media', link.getAttribute('media'));
        link.parentNode.replaceChild(style, link);
      } catch (e) {
        console.warn('Skipped stylesheet:', href, e);
      }
    }

    // ── 2. Process inline <style> blocks ──────────────────────────────────
    btn.textContent = 'Inlining fonts…';
    for (const style of Array.from(doc.querySelectorAll('style'))) {
      style.textContent = await inlineCssUrls(style.textContent, pageUrl);
    }

    // ── 3. Inline images ──────────────────────────────────────────────────
    btn.textContent = 'Inlining images…';
    const imgEls = Array.from(doc.querySelectorAll('img[src]'));
    for (const img of imgEls) {
      const src = img.getAttribute('src');
      if (!src || src.startsWith('data:')) continue;
      try {
        const absUrl = new URL(src, pageUrl).href;
        img.setAttribute('src', await toDataUri(absUrl));
      } catch (e) {
        console.warn('Skipped image:', src, e);
      }
      // srcset would point to the same or alternate-resolution images;
      // remove it so the browser uses the now-inlined src instead.
      img.removeAttribute('srcset');
      img.removeAttribute('loading');
      img.removeAttribute('decoding');
    }

    // ── 4. Inline <source> elements (picture / video / audio) ─────────────
    for (const src_el of Array.from(doc.querySelectorAll('source[src]'))) {
      const src = src_el.getAttribute('src');
      if (!src || src.startsWith('data:')) continue;
      try {
        src_el.setAttribute('src', await toDataUri(new URL(src, pageUrl).href));
      } catch (e) {}
      src_el.removeAttribute('srcset');
    }

    // ── 5. Rewrite <a href> to absolute URLs ──────────────────────────────
    for (const a of doc.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      if (!href) continue;
      const skip = href.startsWith('#') || href.startsWith('data:') ||
                   href.startsWith('mailto:') || href.startsWith('javascript:') ||
                   href.startsWith('tel:');
      if (skip) continue;
      try { a.setAttribute('href', new URL(href, pageUrl).href); } catch (e) {}
    }

    // ── 6. Optional: strip scripts (uncomment to remove JS from saved page)
    // for (const s of doc.querySelectorAll('script')) s.remove();

    btn.textContent = 'Saving…';
    const content = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
    const filename = safeFilename(title, '.html');
    await downloadBlob(content, filename, 'text/html');
    btn.textContent = 'Saved!';
    showStatus(btn, 'Saved: ' + filename, true);
  }

  // ── Save as Markdown (Readability + Turndown) ──────────────────────────────

  async function saveAsMd(btn) {
    const tab = await getActiveTab();
    const { html, title, url } = await getPageHtml(tab.id);

    const parser = new DOMParser();
    const dom = parser.parseFromString(html, 'text/html');

    let content;
    let articleTitle = title;
    try {
      const article = new Readability(dom).parse();
      if (article && article.content) {
        content = article.content;
        if (article.title) articleTitle = article.title;
      } else {
        content = dom.body.innerHTML;
      }
    } catch (e) {
      console.warn('Readability failed, falling back to body:', e);
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

    turndownService.addRule('fencedCodeBlock', {
      filter: (node) =>
        node.nodeName === 'PRE' &&
        node.firstChild &&
        node.firstChild.nodeName === 'CODE',
      replacement: (content, node) => {
        const codeEl = node.firstChild;
        const langClass = codeEl.className || '';
        const langMatch = langClass.match(/(?:language|lang)-(\S+)/);
        const lang = langMatch ? langMatch[1] : '';
        const code = codeEl.textContent.replace(/\n$/, '');
        return '\n\n```' + lang + '\n' + code + '\n```\n\n';
      }
    });

    const markdown = turndownService.turndown(content);

    const frontmatter =
      '---\n' +
      'title: ' + articleTitle.replace(/:/g, '&#58;') + '\n' +
      'source: ' + url + '\n' +
      '---\n\n';

    const filename = safeFilename(articleTitle, '.md');
    await downloadBlob(frontmatter + markdown, filename, 'text/markdown');
    btn.textContent = 'Saved!';
    showStatus(btn, 'Saved: ' + filename, true);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function showStatus(button, message, isSuccess) {
    const old = button.parentNode.querySelector('.status-msg');
    if (old) old.remove();
    const div = document.createElement('div');
    div.textContent = message;
    div.className = 'status-msg';
    div.style.cssText = `
      margin-top: 8px;
      padding: 6px 10px;
      background: ${isSuccess ? '#d4edda' : '#f8d7da'};
      color: ${isSuccess ? '#155724' : '#721c24'};
      border: 1px solid ${isSuccess ? '#c3e6cb' : '#f5c6cb'};
      border-radius: 4px;
      font-size: 12px;
      word-break: break-all;
    `;
    button.parentNode.appendChild(div);
    setTimeout(() => { if (div.parentNode) div.remove(); }, 5000);
  }
});
