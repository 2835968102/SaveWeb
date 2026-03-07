document.addEventListener('DOMContentLoaded', function () {
  setupButton('saveHtml', 'Save as HTML', saveAsHtml);
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

  // Get the full page HTML from the active tab, with base href fixed for relative URLs.
  // Mirrors markdownload's contentScript approach.
  async function getPageHtml(tabId) {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // Ensure a <title> exists
        if (document.head.getElementsByTagName('title').length === 0) {
          const t = document.createElement('title');
          t.innerText = document.title;
          document.head.append(t);
        }

        // Ensure a <base> element exists with an absolute href so that
        // relative links/images resolve correctly after DOMParser re-parse.
        let baseEl = document.head.querySelector('base');
        if (!baseEl) {
          baseEl = document.createElement('base');
          document.head.append(baseEl);
        }
        const href = baseEl.getAttribute('href') || '';
        if (!href || !href.startsWith(window.location.origin)) {
          baseEl.setAttribute('href', window.location.href);
        }

        return {
          html: document.documentElement.outerHTML,
          title: document.title || 'Untitled',
          url: window.location.href
        };
      }
    });
    return result[0].result;
  }

  // ── Save as HTML ──────────────────────────────────────────────────────────

  async function saveAsHtml(btn) {
    const tab = await getActiveTab();
    const { html, title } = await getPageHtml(tab.id);
    const content = '<!DOCTYPE html>\n' + html;
    const filename = safeFilename(title, '.html');
    await downloadBlob(content, filename, 'text/html');
    btn.textContent = 'Saved!';
    showStatus(btn, 'Saved: ' + filename, true);
  }

  // ── Save as Markdown (Readability + Turndown, like markdownload) ──────────

  async function saveAsMd(btn) {
    const tab = await getActiveTab();
    const { html, title, url } = await getPageHtml(tab.id);

    // 1. Parse the HTML string into a DOM (runs in popup context)
    const parser = new DOMParser();
    const dom = parser.parseFromString(html, 'text/html');

    // 2. Run Readability to extract main article content
    let content;
    let articleTitle = title;
    try {
      const article = new Readability(dom).parse();
      if (article && article.content) {
        content = article.content;
        if (article.title) articleTitle = article.title;
      } else {
        // Readability found nothing useful — fall back to full body
        content = dom.body.innerHTML;
      }
    } catch (e) {
      console.warn('Readability failed, falling back to body:', e);
      content = dom.body.innerHTML;
    }

    // 3. Convert extracted HTML → Markdown with Turndown + GFM plugin
    const turndownService = new TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      emDelimiter: '_',
      linkStyle: 'inlined',
      linkReferenceStyle: 'full'
    });

    // Apply the full GFM plugin (tables, strikethrough, task list items, etc.)
    turndownService.use(turndownPluginGfm.gfm);

    // Preserve a few inline elements as-is (same as markdownload)
    turndownService.keep(['sub', 'sup', 'u', 'ins', 'del', 'small', 'big']);

    // Better fenced code block handling: detect language from class name
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

    // 4. Assemble final document with a YAML-style title header
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
