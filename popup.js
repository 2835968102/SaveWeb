document.addEventListener('DOMContentLoaded', function() {
  const saveButton = document.getElementById('saveHtml');
  
  if (!saveButton) {
    console.error('Save button not found');
    return;
  }
  
  const originalText = 'save as PDF';
  let isSaving = false;
  
  saveButton.addEventListener('click', async function() {
    if (isSaving) {
      console.log('Already saving, please wait...');
      return;
    }
    
    isSaving = true;
    saveButton.disabled = true;
    saveButton.textContent = 'Preparing...';
    
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!tabs || tabs.length === 0) {
        throw new Error('No active tab found');
      }
      
      const tab = tabs[0];
      
      if (!tab.url || !tab.url.startsWith('http')) {
        if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://'))) {
          throw new Error('Cannot save Chrome internal pages. Please visit a normal webpage.');
        } else {
          throw new Error('Can only save HTTP or HTTPS webpages');
        }
      }
      
      saveButton.textContent = 'Capturing...';
      
      const pageInfo = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({
          title: document.title || 'Untitled Page',
          url: window.location.href
        })
      });
      
      const title = pageInfo[0]?.result?.title || 'Page';
      const safeTitle = title
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 100) || 'Page';
      
      const filename = safeTitle + '.pdf';
      
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: 'png',
        quality: 100
      });
      
      if (!dataUrl) {
        throw new Error('Cannot capture screenshot');
      }
      
      saveButton.textContent = 'Generating PDF...';
      
      const jsPDF = window.jspdf.jsPDF;
      
      const img = new Image();
      img.src = dataUrl;
      
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
      });
      
      const imgWidth = img.width;
      const imgHeight = img.height;
      
      const pdf = new jsPDF({
        orientation: imgWidth > imgHeight ? 'l' : 'p',
        unit: 'px',
        format: [imgWidth, imgHeight]
      });
      
      pdf.addImage(dataUrl, 'PNG', 0, 0, imgWidth, imgHeight);
      
      saveButton.textContent = 'Saving...';
      
      const pdfBlob = pdf.output('blob');
      const blobUrl = URL.createObjectURL(pdfBlob);
      
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      a.style.display = 'none';
      
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      
      setTimeout(() => {
        URL.revokeObjectURL(blobUrl);
      }, 1000);
      
      saveButton.textContent = 'Saved!';
      
      const successDiv = document.createElement('div');
      successDiv.textContent = `Saved: ${filename}`;
      successDiv.style.cssText = `
        margin-top: 10px;
        padding: 8px 12px;
        background-color: #d4edda;
        color: #155724;
        border: 1px solid #c3e6cb;
        border-radius: 4px;
        font-size: 12px;
        word-break: break-all;
      `;
      
      const oldStatus = document.querySelector('.pdf-status');
      if (oldStatus) {
        oldStatus.remove();
      }
      
      successDiv.className = 'pdf-status';
      saveButton.parentNode.insertBefore(successDiv, saveButton.nextSibling);
      
      setTimeout(() => {
        saveButton.textContent = originalText;
        saveButton.disabled = false;
        isSaving = false;
        
        setTimeout(() => {
          if (successDiv.parentNode) {
            successDiv.remove();
          }
        }, 3000);
      }, 2000);
      
    } catch (error) {
      console.error('Save PDF failed:', error);
      
      saveButton.textContent = 'Failed';
      
      const errorDiv = document.createElement('div');
      let errorMessage = error.message || 'Unknown error';
      
      errorDiv.textContent = 'Error: ' + errorMessage;
      errorDiv.style.cssText = `
        margin-top: 10px;
        padding: 8px 12px;
        background-color: #f8d7da;
        color: #721c24;
        border: 1px solid #f5c6cb;
        border-radius: 4px;
        font-size: 12px;
      `;
      
      const oldError = document.querySelector('.pdf-error');
      if (oldError) {
        oldError.remove();
      }
      
      errorDiv.className = 'pdf-error';
      saveButton.parentNode.insertBefore(errorDiv, saveButton.nextSibling);
      
      setTimeout(() => {
        saveButton.textContent = originalText;
        saveButton.disabled = false;
        isSaving = false;
        
        setTimeout(() => {
          if (errorDiv.parentNode) {
            errorDiv.remove();
          }
        }, 3000);
      }, 2000);
    }
  });
});
