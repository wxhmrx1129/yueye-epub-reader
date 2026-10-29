# Windows 安装与使用说明

阅野支持 Windows 10 / 11 的 x64 系统。安装完成后可以离线导入和阅读 EPUB，无需安装 Node.js、另开浏览器或启动开发服务器。

## 获取安装程序

**[直接下载 v1.0.0 Windows x64 安装包](https://github.com/wxhmrx1129/yueye-epub-reader/releases/download/v1.0.0/YueyeReader-Setup-1.0.0-x64.exe)**

下载文件为 `YueyeReader-Setup-1.0.0-x64.exe`。无需安装 Node.js、Git 或其他构建工具，也无需下载 GitHub 自动生成的源代码压缩包。

可在 [v1.0.0 发布页面](https://github.com/wxhmrx1129/yueye-epub-reader/releases/tag/v1.0.0) 查看版本说明和 `SHA256SUMS.txt` 校验文件，或通过 [最新版本页面](https://github.com/wxhmrx1129/yueye-epub-reader/releases/latest) 获取后续版本。

## 安装与启动

1. 双击下载的 `YueyeReader-Setup-1.0.0-x64.exe`。
2. 按安装向导选择安装位置并完成安装。
3. 通过桌面或开始菜单的「阅野」快捷方式打开客户端。

程序文件名为 `YueyeReader.exe`。当前安装包尚未配置代码签名，Windows 可能显示「未知发布者」，请确认文件来自本项目的发布页面。

## 导入和阅读

- 在书架点击导入按钮选择 `.epub` 文件，支持一次选择多本，也可以拖入文件。
- 首次使用可点击「先读一本示例书」体验阅读功能。
- 点击书籍进入阅读，使用左侧目录、前后页按钮或左右方向键跳转。分页模式支持 PageUp / PageDown。
- 阅读设置可调整主题、字号、字体、行距和内容宽度，并切换分页或纵向滚动。
- 数字输入在 Enter 或离开输入框时生效；页码会随排版和窗口大小重新计算。
- 使用书签按钮记录当前位置。选中文字后可添加高亮和笔记，保存后可在侧栏查看和跳转。
- 阅读进度自动保存。退出客户端前请保存正在编辑的笔记；正常关闭时，程序会等待已经提交的阅读记录和设置写入完成。

支持常见的无 DRM、横排可重排 EPUB 2 / 3。其他格式及具体限制见 [项目说明](../README.md#格式与限制)。

## 数据保存与备份

客户端数据位于当前 Windows 账户的：

```text
%APPDATA%\YueyeReader
```

可在资源管理器地址栏输入上述路径。此目录保存本地图书数据库、阅读进度、排版设置、书签和笔记。

备份步骤：

1. 完全退出阅野。
2. 将整个 `YueyeReader` 数据目录复制到备份位置。
3. 恢复时先退出客户端，再将完整备份恢复到同一位置。建议在相同客户端版本之间恢复。

项目目前没有云同步及应用内导出、恢复功能。删除数据目录会清除本地书架和记录。

## 从网页版切换

桌面版与网页版使用独立书架。第一次使用桌面客户端时，请重新导入原来的 EPUB 文件。浏览器中的阅读进度、书签、笔记不会自动迁入客户端。

不同浏览器、站点地址和端口也使用独立的网页书架。

## 更新与卸载

更新时，先退出正在运行的客户端，再安装新版本。客户端使用固定数据目录，覆盖安装会继续读取该目录中的数据；更新前建议备份。

卸载可通过 Windows 的应用管理页面进行。默认卸载保留 `%APPDATA%\YueyeReader`，重新安装后可继续读取原书架。如需清除记录，请在确认备份后自行删除数据目录。

## 常见问题

**安装后没有图书？** 桌面版有独立的本地书架，请重新导入 EPUB，或者先体验示例书。

**不能只复制 `YueyeReader.exe` 使用？** 目录版依赖同目录的运行时文件。请分发安装包，或保留整个 `release/win-unpacked/` 目录。

**页码为什么变化？** 页码由当前窗口与排版实际测量得出。调整字体、字号、行距和宽度后会重新计算。

**关闭时提示保存失败？** 可先选择返回阅读，检查本地存储状态后重试。选择直接退出时，最近尚未保存的修改可能丢失。

**在哪里反馈问题？** 请在 [GitHub Issues](https://github.com/wxhmrx1129/yueye-epub-reader/issues) 说明系统版本、应用版本和复现步骤，避免公开个人图书、阅读记录或凭据。

## 可选：从源码构建

仅需自行修改或生成安装包时，才需要 Node.js 22.12+（推荐 24 LTS）和 Git。在 Windows x64 环境执行：

```powershell
git clone https://github.com/wxhmrx1129/yueye-epub-reader.git
cd yueye-epub-reader
npm ci
npm run desktop:dist
```

安装包输出到 `release/YueyeReader-Setup-<版本号>-x64.exe`。如果只想从源码直接运行，可以使用 `npm run desktop`。
