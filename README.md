# SaveWeb - 网页转PDF扩展

一个简单的Chrome扩展程序，可以将当前网页保存为PDF文件。

## 功能

- 点击扩展图标弹出浮窗
- 点击 "save as HTML" 按钮将当前网页保存为PDF文件

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

1. 访问任意网页
2. 点击浏览器工具栏中的扩展图标
3. 点击 "save as HTML" 按钮
4. PDF文件将自动下载到本地

## 技术栈

- Manifest V3
- Chrome Tabs API - 页面截图
- jsPDF - 生成PDF文件

## 文件说明

```
.
├── manifest.json    # 扩展配置文件
├── popup.html       # 扩展弹窗页面
├── popup.js         # 弹窗逻辑脚本
├── background.js    # 后台服务Worker
├── style.css        # 样式文件
├── jspdf.min.js     # jsPDF库
└── icon*.png        # 扩展图标
```

## 注意事项

- 只能保存 HTTP/HTTPS 网页
- 无法保存 Chrome 内部页面（如 chrome:// 开头的页面）
- 保存的是当前可见区域的内容

## License

MIT
