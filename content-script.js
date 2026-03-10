console.log('Content script loaded! URL:', window.location.href);

// Listen for message from background service worker
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== 'processPage') return false;

  (async () => {
    try {
      // Step 1: Get page HTML and metadata
      if (document.head.getElementsByTagName('title').length === 0) {
        const t = document.createElement('title');
        t.innerText = document.title;
        document.head.append(t);
      }
      for (const b of document.head.querySelectorAll('base')) b.remove();

      const pageData = {
        html: document.documentElement.outerHTML,
        title: document.title || 'Untitled',
        url: window.location.href
      };

      // Step 2: Parse HTML and extract article with Readability
      const parser = new DOMParser();
      const dom = parser.parseFromString(pageData.html, 'text/html');
      let content;
      let articleTitle = pageData.title;
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

      // Step 3: Convert HTML to Markdown with Turndown
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

      // Step 4: Add frontmatter
      const frontmatter =
        '---\n' +
        'title: ' + articleTitle.replace(/:/g, '&#58;') + '\n' +
        'source: ' + pageData.url + '\n' +
        '---\n\n';

      sendResponse({
        success: true,
        markdown: frontmatter + markdown,
        title: articleTitle
      });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true; // Keep message channel open
});
