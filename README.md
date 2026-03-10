# WebDualSaver - 网页双格式自动保存扩展

一个Chrome扩展程序，可以**自动保存访问的网页**为两种格式：
- **Markdown**（用于笔记，保存到 `save_as_markdown/` 文件夹）
- **单文件 HTML**（用于完整归档，保存到 `save_as_html/` 文件夹）

## 功能

### 手动保存
- 点击扩展图标弹出浮窗
- 点击 "Save as Single File" 按钮将当前网页保存为单文件 HTML
- 点击 "Save as Markdown" 按钮将当前网页保存为 Markdown（可选：保存图片到本地文件夹）

### 自动保存
- 访问任意 HTTP/HTTPS 网页时，等待页面加载完成后自动保存
- 同时保存 Markdown 和单文件 HTML 两种格式
- Markdown 保存到 `下载/save_as_markdown/` 文件夹
- HTML 保存到 `下载/save_as_html/` 文件夹
- 文件命名格式：`网页标题_YYYYMMDD-HHMMSS.md` / `.html`

## 安装方法

### 开发者模式安装（推荐）

1. 下载或克隆本仓库到本地
2. 打开 Chrome 浏览器，访问 `chrome://extensions/`
3. 开启右上角的「开发者模式」
4. 点击「加载已解压的扩展程序」
5. 选择本项目文件夹

### 从Chrome应用商店安装

（待发布）

## 使用方法

### 手动保存
1. 访问任意网页
2. 点击浏览器工具栏中的扩展图标
3. 选择保存格式：
   - "Save as Single File" → 保存单文件 HTML
   - "Save as Markdown" → 保存 Markdown（可勾选 "Save images to local folder" 保存图片）
4. 文件将自动下载到本地

### 自动保存
1. 确保扩展已安装并启用
2. 访问任意 HTTP/HTTPS 网页
3. 等待 3 秒（页面完全加载后）
4. 检查 `下载/` 文件夹中的 `save_as_markdown/` 和 `save_as_html/` 子文件夹

## 技术栈

- Manifest V3
- Chrome Scripting API - 注入脚本到网页
- Chrome Downloads API - 下载文件
- Readability.js - 提取网页文章内容
- Turndown.js + Turndown Plugin GFM - HTML 转 Markdown
- Chrome Runtime Messaging - 后台与内容脚本通信

## 文件说明

```
.
├── manifest.json              # 扩展配置文件
├── popup.html                 # 扩展弹窗页面
├── popup.js                   # 弹窗逻辑脚本（手动保存）
├── background.js              # 后台服务Worker（自动保存）
├── style.css                  # 样式文件
├── Readability.js             # Readability 库（文章提取）
├── turndown.js                # Turndown 库（HTML转Markdown）
├── turndown-plugin-gfm.js     # Turndown GFM 插件（GitHub风格Markdown）
├── content-script.js          # 旧内容脚本（已弃用，保留用于参考）
└── icon*.png                  # 扩展图标
```

## 注意事项

- 只能保存 HTTP/HTTPS 网页
- 无法保存 Chrome 内部页面（如 chrome:// 开头的页面）
- 部分有严格 Content Security Policy (CSP) 的页面可能无法正常保存
- 自动保存等待时间为 3 秒，确保页面完全加载
- Markdown 文件包含 frontmatter（标题和来源 URL）

## License

MIT
