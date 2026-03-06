document.addEventListener('DOMContentLoaded', function() {
  const saveButton = document.getElementById('saveHtml');

  if (!saveButton) {
    console.error('Save button not found');
    return;
  }

  const originalText = 'save as PDF';
  let isSaving = false;

  saveButton.addEventListener('click', async function() {
    if (isSaving) return;

    isSaving = true;
    saveButton.disabled = true;
    saveButton.textContent = 'Preparing...';

    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tabs || tabs.length === 0) throw new Error('No active tab found');

      const tab = tabs[0];

      if (!tab.url || !tab.url.startsWith('http')) {
        if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://'))) {
          throw new Error('Cannot save Chrome internal pages. Please visit a normal webpage.');
        } else {
          throw new Error('Can only save HTTP or HTTPS webpages');
        }
      }

      // Get page dimensions and current scroll position
      const pageInfoResult = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({
          title: document.title || 'Untitled Page',
          scrollHeight: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
          savedScrollX: window.scrollX,
          savedScrollY: window.scrollY
        })
      });

      const { title, scrollHeight, viewportWidth, viewportHeight, devicePixelRatio, savedScrollX, savedScrollY } =
        pageInfoResult[0].result;

      const safeTitle = title.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim().substring(0, 100) || 'Page';
      const filename = safeTitle + '.pdf';

      // Hide fixed/sticky elements so they don't repeat in every screenshot
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          document.querySelectorAll('*').forEach(el => {
            const pos = window.getComputedStyle(el).position;
            if (pos === 'fixed' || pos === 'sticky') {
              el.setAttribute('data-pdf-saved-visibility', el.style.visibility || '');
              el.style.visibility = 'hidden';
            }
          });
        }
      });

      // Scroll through the entire page and capture screenshots
      const screenshots = [];
      const totalSteps = Math.ceil(scrollHeight / viewportHeight);
      let targetScrollY = 0;
      let step = 0;

      while (targetScrollY < scrollHeight) {
        step++;
        saveButton.textContent = `Capturing ${step}/${totalSteps}...`;

        // Scroll to target position, get actual scroll position (may be clamped by browser)
        const scrollResult = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (y) => {
            window.scrollTo(0, y);
            return window.scrollY;
          },
          args: [targetScrollY]
        });

        const actualScrollY = scrollResult[0].result;

        // Wait for page to re-render after scroll (must be >=500ms to respect Chrome quota)
        await new Promise(resolve => setTimeout(resolve, 600));

        // Retry captureVisibleTab on rate-limit errors
        let dataUrl;
        for (let attempt = 1; attempt <= 5; attempt++) {
          try {
            dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
              format: 'png',
              quality: 100
            });
            break;
          } catch (captureErr) {
            if (attempt === 5) throw captureErr;
            await new Promise(resolve => setTimeout(resolve, 600 * attempt));
          }
        }

        screenshots.push({ dataUrl, scrollY: actualScrollY });

        // Stop if we've captured past the bottom of the page
        if (actualScrollY + viewportHeight >= scrollHeight) break;

        targetScrollY += viewportHeight;
      }

      // Restore original scroll position
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (x, y) => window.scrollTo(x, y),
        args: [savedScrollX, savedScrollY]
      });

      // Restore fixed/sticky elements
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          document.querySelectorAll('[data-pdf-saved-visibility]').forEach(el => {
            el.style.visibility = el.getAttribute('data-pdf-saved-visibility');
            el.removeAttribute('data-pdf-saved-visibility');
          });
        }
      });

      saveButton.textContent = 'Generating PDF...';

      // Stitch all screenshots onto a single canvas
      const physicalWidth = viewportWidth * devicePixelRatio;
      const physicalHeight = scrollHeight * devicePixelRatio;

      const canvas = document.createElement('canvas');
      canvas.width = physicalWidth;
      canvas.height = physicalHeight;
      const ctx = canvas.getContext('2d');

      for (const { dataUrl, scrollY } of screenshots) {
        const img = new Image();
        img.src = dataUrl;
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
        });
        ctx.drawImage(img, 0, scrollY * devicePixelRatio);
      }

      const fullPageDataUrl = canvas.toDataURL('image/png');

      // Generate PDF from the stitched full-page image
      const jsPDF = window.jspdf.jsPDF;
      const pdf = new jsPDF({
        orientation: physicalWidth > physicalHeight ? 'l' : 'p',
        unit: 'px',
        format: [physicalWidth, physicalHeight]
      });

      pdf.addImage(fullPageDataUrl, 'PNG', 0, 0, physicalWidth, physicalHeight);

      saveButton.textContent = 'Saving...';

      const pdfBlob = pdf.output('blob');
      const blobUrl = URL.createObjectURL(pdfBlob);
      await new Promise((resolve, reject) => {
        chrome.downloads.download({ url: blobUrl, filename: filename, saveAs: true }, (downloadId) => {
          URL.revokeObjectURL(blobUrl);
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(downloadId);
        });
      });

      saveButton.textContent = 'Saved!';
      showStatus(saveButton, `Saved: ${filename}`, true);

      setTimeout(() => {
        saveButton.textContent = originalText;
        saveButton.disabled = false;
        isSaving = false;
      }, 2000);

    } catch (error) {
      // Make sure fixed/sticky elements are restored on error
      try {
        const tabs2 = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs2 && tabs2[0]) {
          await chrome.scripting.executeScript({
            target: { tabId: tabs2[0].id },
            func: () => {
              document.querySelectorAll('[data-pdf-saved-visibility]').forEach(el => {
                el.style.visibility = el.getAttribute('data-pdf-saved-visibility');
                el.removeAttribute('data-pdf-saved-visibility');
              });
            }
          });
        }
      } catch (_) {}

      console.error('Save PDF failed:', error);
      saveButton.textContent = 'Failed';
      showStatus(saveButton, 'Error: ' + (error.message || 'Unknown error'), false);

      setTimeout(() => {
        saveButton.textContent = originalText;
        saveButton.disabled = false;
        isSaving = false;
      }, 2000);
    }
  });

  function showStatus(button, message, isSuccess) {
    const oldStatus = button.parentNode.querySelector('.pdf-status, .pdf-error');
    if (oldStatus) oldStatus.remove();

    const div = document.createElement('div');
    div.textContent = message;
    div.className = isSuccess ? 'pdf-status' : 'pdf-error';
    div.style.cssText = `
      margin-top: 10px;
      padding: 8px 12px;
      background-color: ${isSuccess ? '#d4edda' : '#f8d7da'};
      color: ${isSuccess ? '#155724' : '#721c24'};
      border: 1px solid ${isSuccess ? '#c3e6cb' : '#f5c6cb'};
      border-radius: 4px;
      font-size: 12px;
      word-break: break-all;
    `;
    button.parentNode.insertBefore(div, button.nextSibling);

    setTimeout(() => {
      if (div.parentNode) div.remove();
    }, 5000);
  }
});
