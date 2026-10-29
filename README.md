# 阅野 · EPUB 阅读器

阅野是一个无需登录、在本机保存图书和阅读记录的 EPUB 阅读器，支持 Windows 桌面客户端和网页运行。

## 功能

- 本地书架：批量导入、拖放、封面、搜索、排序、重复识别和继续阅读。
- 支持常见的无 DRM、横排可重排 EPUB 2 / 3，以及多级目录和书内链接。
- 真实分页、全书页码跳转、纵向滚动和阅读进度恢复。
- 多种主题、字号、字体、内容宽度、行间距与全屏阅读。
- 书签、文字高亮、笔记，以及本地持久保存。
- Windows 客户端可离线使用，不需要另开浏览器或启动服务器。

## 安装 Windows 客户端

支持 Windows 10 / 11 x64。

本仓库发布源代码，不附带预编译安装包。可按照下方步骤从源码生成 `YueyeReader-Setup-<版本号>-x64.exe`，然后双击安装，按向导选择安装位置。安装完成后，通过桌面或开始菜单的「阅野」快捷方式启动。

安装好的客户端不需要 Node.js。自行构建且未配置代码签名的安装包，Windows 可能显示「未知发布者」。

完整的导入、阅读、数据备份及卸载说明见 [Windows 安装与使用说明](docs/Windows客户端.md)。

## 从源码运行

需要 Node.js 22.12+（推荐 Node.js 24 LTS）、npm，以及首次下载依赖时的网络连接。

```powershell
git clone https://github.com/wxhmrx1129/yueye-epub-reader.git
cd yueye-epub-reader
npm ci
npm run desktop
```

构建 Windows 安装包时，在 Windows x64 环境执行：

```powershell
npm run desktop:dist
```

安装包输出到 `release/`，例如 `release/YueyeReader-Setup-1.0.0-x64.exe`。`release/win-unpacked/` 是完整目录版，不能仅复制其中的单个 EXE 使用。

| 命令 | 用途 |
| --- | --- |
| `npm run desktop` | 构建并启动客户端 |
| `npm run desktop:dev` | 启动桌面开发模式与热更新 |
| `npm run desktop:pack` | 生成 Windows x64 目录版 |
| `npm run desktop:dist` | 生成 Windows x64 安装程序 |
| `npm run dev` | 启动网页版本，默认地址为 `http://127.0.0.1:5173/` |
| `npm run build` | 检查类型并生成网页资源到 `dist/` |
| `npm run preview` | 本地预览网页生产构建 |

网页版本应通过本地服务器或 HTTPS 访问，不要直接双击 `index.html`。网页生产部署可将 `dist/` 作为静态站点发布，无需后端服务。

## 开始阅读

1. 在书架点击导入按钮，选择一个或多个 `.epub` 文件，也可以将文件拖入书架。
2. 点击书籍打开阅读；首次使用可点击「先读一本示例书」。
3. 使用目录、前后页按钮、左右方向键或 PageUp / PageDown 翻页。
4. 在阅读设置中调整排版；选中文字后可添加高亮或笔记。
5. 阅读进度自动保存。正常关闭客户端时，会等待已经提交的本地写入完成。

字号和正文宽度的数字输入在按 Enter 或离开输入框时生效。全书页码随窗口、字体和排版变化，不对应纸书页码。滚动阅读每次展示一个章节，通过前后章节按钮换章。

## 本地数据

Windows 客户端数据保存在 `%APPDATA%\YueyeReader`，默认卸载保留。备份前请完全退出客户端，再复制整个数据目录。

网页版的数据保存在当前浏览器的当前站点地址中。不同浏览器、地址、端口，以及桌面客户端使用独立书架，数据不会自动互通。转用客户端时需要重新导入 EPUB，原浏览器中的阅读进度、书签和笔记不会自动迁入。

图书和记录不会自动上传。清除数据目录或浏览器站点数据会清除相应记录；目前没有云同步及应用内导出、恢复功能。

## 格式与限制

- 不支持 PDF、TXT、MOBI、DRM、固定版式、RTL 阅读方向和竖排 EPUB。
- 不执行书内 JavaScript，不加载书内远程图片、字体或样式，不支持音视频和交互式 EPUB。
- `linear="no"` 的独立辅助章节暂不参与阅读，指向这类文件的脚注可能无法打开。
- 单个原文件上限为 50 MiB，ZIP 解压总量上限为 250 MiB，单项上限为 50 MiB，最多 10,000 项。
- 复杂公式、特殊字体、超宽表格及超大图书可能存在兼容性或性能问题。

网页版优先使用新版 Edge 或 Chrome，需要 IndexedDB、Web Locks、CSS Custom Highlight 和 Fullscreen API。

## 检查与维护

```powershell
npm test
node --test tests/desktop-policy.test.cjs
npm run build
npm run test:e2e
npm run test:desktop
```

浏览器集成测试默认使用本机安装的 Microsoft Edge。如使用 Chrome，先在 PowerShell 中设置 `$env:PLAYWRIGHT_CHANNEL='chrome'`。桌面测试使用独立临时数据目录，不访问日常书架。

React、TypeScript、Vite 和 Electron 提供应用与桌面打包；fflate 处理压缩包，DOMPurify 清理书内内容，Dexie 管理本地数据库，epub.js 提供 CFI 定位。

内置示例书《把日子读成诗》及测试图书由本项目生成，正文、封面与插画为原创样本。运行 `node scripts/create-fixtures.mjs` 可重新生成。

问题反馈和功能建议请使用 [GitHub Issues](https://github.com/wxhmrx1129/yueye-epub-reader/issues)，也欢迎提交 Pull Request。提交前请避免包含个人图书、阅读记录、凭据或本地配置。

## 许可证

项目采用 [MIT License](LICENSE)。第三方依赖遵循各自的许可证。
