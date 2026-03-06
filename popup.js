document.getElementById('clickMe').addEventListener('click', function() {
    alert('Button clicked!');
});

// popup.js - 使用pageCapture API保存为PDF
document.addEventListener('DOMContentLoaded', function() {
  const saveButton = document.getElementById('saveHtml'); // 或 savePdf
  
  if (!saveButton) {
    console.error('找不到保存按钮');
    return;
  }
  
  const originalText = saveButton.textContent;
  let isSaving = false;
  
  saveButton.addEventListener('click', async function() {
    if (isSaving) {
      console.log('正在保存中，请稍候...');
      return;
    }
    
    isSaving = true;
    saveButton.disabled = true;
    saveButton.textContent = '准备中...';
    
    try {
      // 获取当前标签页
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!tabs || tabs.length === 0) {
        throw new Error('没有找到活动标签页');
      }
      
      const tab = tabs[0];
      
      // 检查页面类型
      if (!tab.url || !tab.url.startsWith('http')) {
        if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://'))) {
          throw new Error('无法保存Chrome内部页面或扩展程序页面。请访问普通网页。');
        } else {
          throw new Error('只能保存HTTP或HTTPS网页');
        }
      }
      
      saveButton.textContent = '生成PDF中...';
      
      // 使用pageCapture API保存为PDF
      const pdfData = await new Promise((resolve, reject) => {
        chrome.pageCapture.saveAsPDF(
          { tabId: tab.id },
          (pdfData) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(pdfData);
            }
          }
        );
      });
      
      if (!pdfData) {
        throw new Error('无法生成PDF文件');
      }
      
      // 获取页面标题作为文件名
      const pageInfo = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({
          title: document.title || '未命名页面',
          url: window.location.href
        })
      });
      
      const title = pageInfo[0]?.result?.title || '网页';
      const safeTitle = title
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 100) || '网页';
      
      const filename = safeTitle + '.pdf';
      
      saveButton.textContent = '保存文件中...';
      
      // 创建Blob并下载
      const blob = new Blob([pdfData], { type: 'application/pdf' });
      const blobUrl = URL.createObjectURL(blob);
      
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      a.style.display = 'none';
      
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      
      // 清理
      setTimeout(() => {
        URL.revokeObjectURL(blobUrl);
      }, 1000);
      
      saveButton.textContent = '保存成功！';
      
      // 显示成功消息
      const successDiv = document.createElement('div');
      successDiv.textContent = `已保存: ${filename}`;
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
      
      // 2秒后恢复按钮
      setTimeout(() => {
        saveButton.textContent = originalText;
        saveButton.disabled = false;
        isSaving = false;
        
        // 3秒后隐藏提示
        setTimeout(() => {
          if (successDiv.parentNode) {
            successDiv.remove();
          }
        }, 3000);
      }, 2000);
      
    } catch (error) {
      console.error('保存PDF失败:', error);
      
      saveButton.textContent = '保存失败';
      
      // 显示错误消息
      const errorDiv = document.createElement('div');
      let errorMessage = error.message;
      
      // 提供更友好的错误提示
      if (error.message.includes('pageCapture')) {
        errorMessage = 'pageCapture API不可用。请检查manifest.json权限配置。';
      } else if (error.message.includes('permission')) {
        errorMessage = '权限不足。请检查插件权限设置。';
      }
      
      errorDiv.textContent = '错误: ' + errorMessage;
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