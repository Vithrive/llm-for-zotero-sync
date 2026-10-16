# LLM for Zotero Sync

Zotero 7+ 插件，**llm-for-zotero** 的伴生插件：把 MinerU 解析出的 Markdown
（`V:\Zotero\llm-for-zotero-mineru\<attachmentId>\` 下的 `*.md`、`*_content_list.json`）
同步到文献条目下的一条自动维护笔记里，并渲染成带目录/图片/公式的可读笔记。

> **改名说明**：本插件原名 *MinerU Markdown Sync*（ID `mineru-markdown-sync@cszr`）。
> 现改名为 **LLM for Zotero Sync**，ID 为 `llm-for-zotero-sync@cszr`。
> 因为插件 ID 变了，Zotero 会把它当成新插件：请先卸载旧版，再安装本版。
> **已同步过的旧笔记不会被重复创建**：旧版写入的标记 `data-mineru-markdown-sync="1"`
> 仍被识别，新的标记为 `data-llm-for-zotero-sync="1"`。旧版遗留的偏好
> （`extensions.mineru-markdown-sync.*`）同样会被兜底读取。

## 功能

- 阅读器工具栏注入「同步 MinerU」按钮：为当前 PDF 找解析目录，把 Markdown 同步进条目笔记
- 文献列表右键菜单「同步 MinerU Markdown 到笔记」、工具菜单「同步选中条目的 MinerU Markdown」
- 每条「附件 + 源文件」只维护一条笔记：靠笔记 HTML 里的标记定位，重复同步是更新而不是新建，
  同时会报告重复笔记数量
- 优先使用 `*_content_list.json` 渲染结构化正文；`<标题>.zh.md`（译文）不抢 `full.md` 的正文
- 笔记尾部附元信息：源 Markdown 路径、结构化来源、PDF 文件路径、解析目录、父条目
- 正文超过 `200000` 字符时按上限截断，避免笔记过大

## 安装

1. 打开 Zotero → 工具 → 插件（Tools → Plugins / Add-ons）
2. 把 `llm-for-zotero-sync.xpi` 拖进窗口，或点齿轮图标 → Install Add-on From File
3. 重启 Zotero

## 更新

仓库：<https://github.com/Vithrive/llm-for-zotero-sync>

`manifest.json` 里的 `update_url` 指向本仓库 tag 为 `release` 的 Release 中的 `update.json`。
发布新版本：

```powershell
pwsh -File tools/build-xpi.ps1          # 生成 llm-for-zotero-sync.xpi 与 update.json
```

把这两个文件上传到 GitHub Releases（tag 用 `release`，即覆盖同一个 Release），
Zotero 会在「工具 → 插件」里自动检查更新。

## 配置

在 Zotero → 编辑 → 首选项 → 高级 → 配置编辑器（Config Editor）里可覆盖
（前缀 `extensions.llm-for-zotero-sync.`）：

| 键 | 默认值 | 说明 |
|---|---|---|
| `workdirRoot` | `V:\Zotero\llm-for-zotero-mineru` | MinerU 解析结果根目录 |
| `managedTitle` | `LLM for Zotero Sync（自动维护）` | 自动维护笔记里显示的标题行 |

旧版前缀 `extensions.mineru-markdown-sync.*` 仍会被读取：新前缀未设置时自动回退到旧前缀。

## 文件结构

```
llm-for-zotero-sync/
├── addon/                          # 插件源文件（改动后重新打包即可）
│   ├── manifest.json
│   ├── bootstrap.js
│   └── chrome/content/scripts/
│       └── llm-for-zotero-sync.js
├── tools/
│   ├── build-xpi.ps1               # 打 .xpi + 生成 update.json
│   └── test-reader-button.js       # 离线验证按钮挂载位置
├── llm-for-zotero-sync.xpi         # 可直接安装的插件包
└── README.md
```

## 打包

```powershell
pwsh -File tools/build-xpi.ps1
```

要求：zip 格式、manifest.json 必须在压缩包根目录（不要出现 `addon/` 这一层）。
脚本用 `System.IO.Compression` 按 `addon/` 的相对路径写入条目并固定时间戳，
同时按 `manifest.json` 里的 `id`/`version`/`homepage_url` 生成 `update.json`。

## 自检

```powershell
node tools/test-reader-button.js
```

用最小 DOM 桩复刻 `.toolbar > .end > .custom-sections > .section` 结构和
`renderToolbar` 事件派发，检查按钮是否落在官方右侧容器、是否残留 `position: fixed`、
重复渲染是否会产生重复按钮、卸载是否清理干净。不需要启动 Zotero。
