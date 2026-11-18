# pixelgate

[English](README.md) · 中文

![pixelgate：把截图当信号读](docs/images/hero.png)

界面改没改坏，先让它看一遍。它在你自己的机器上跑，MIT 许可，不用注册，图也不传到别人的服务器。

它用真浏览器打开你的页面（或 Storybook 里的每个故事）截图，跟上次存进仓库的图一个像素一个像素地比，然后给你一个网页，只列出变了的那几张；有变化就以非 0 退出。CI、推送前检查、自己写界面的 coding agent，都可以直接拿这个退出码当关卡。

## 为什么要它

改完界面，最费时间的是把每一屏都看一遍。pixelgate 替你看：只有真变了的才拿给你，上次和这次并排放，变了的像素标红。

Happo 这类在线服务也能做，但截图、比对、审查都在人家那边，而且不开源。pixelgate 全在本地：存的图就在你的仓库里，报告就是一个文件夹，里面几张 PNG 加一个 HTML。

![一次运行经过的六站](docs/images/signal-path.png)

## 安装

```bash
pnpm add -D pixelgate-cli playwright
pnpm exec playwright install chromium   # 要测 firefox / webkit 再装它们
```

npm 包名是 `pixelgate-cli`，装好后的命令叫 `pixelgate`。它用你项目里装的那份 Playwright 开浏览器，所以浏览器版本不会对不上。需要 Node 22.18+ 或 23.6+，配置文件写成 `.ts` 也不用先编译。

## 配置

项目根目录放 `pixelgate.config.ts`：

```ts
import { defineConfig } from 'pixelgate-cli';

export default defineConfig({
  targets: {
    desktop: { browser: 'chromium', viewport: '1280x720' },
    phone: { device: 'Pixel 7' },
  },
  pages: [
    { name: 'home', url: 'http://localhost:5173/' },
    { name: 'settings-form', url: 'http://localhost:5173/settings', selector: 'form' },
  ],
  storybook: { url: 'http://localhost:6006' },
  threshold: 0.1,
  failOn: ['changed', 'error'],
});
```

## 用法

```bash
pixelgate run                    # 截图、比对、出报告；门禁不过退出码 1
pixelgate run --only 'button--*' # 只跑匹配的快照（改了哪个件就只查哪个）
pixelgate approve --only '<glob>'# 把看过的变化收为新基线
pixelgate summary                # 上次报告的 Markdown，贴进 PR 评论
pixelgate run --json             # 报告 JSON 打到 stdout，给脚本与 agent 读
```

退出码：`0` 通过，`1` 出现了 `failOn` 里列的状态或检查发现，`2` 用法或配置写错。

## 还能做什么

| 能力 | 一句话 |
| --- | --- |
| 稳定截图 | 等字体与图片、动画归零、关光标、可冻结时钟；连续两帧一样才算稳，一直在动的报 `error` 而不是随机 `changed` |
| 比对方式 | 默认 pixelmatch（逐像素，阈值 0.1，忽略抗锯齿）；也可以换 SSIM，或自己注册 |
| 检查 | axe 无障碍、横向溢出、页面报错、控制台错误、失败请求；不需要基线，列进 `failOn` 才拦 |
| ARIA 快照 | 把无障碍树存成 `.aria.yml`，跟截图一起当基线比 |
| 接入方式 | 独立 CLI；Vite 插件；Vitest 浏览器模式的 `toMatchScreenshot`；Playwright Test 的 reporter |
| 探索 | `pixelgate explore`：随机点击和输入，按 LTL 性质找没想到的坏状态（引擎是 Bombadil） |
| CI | 本仓库就是一个 GitHub Action：跑门禁、上传报告、写 job 摘要、在 PR 上维护一条评论 |

每一项的细节和参数见英文 [README](README.md)。

## 给 coding agent

包里带了一份 agent skill，讲怎么只查改了的、怎么读报告、怎么逐张认可基线：

```bash
pixelgate skill                 # 打印
pixelgate skill install         # 写到 .claude/skills/pixelgate/SKILL.md（Claude Code）
```

升级 pixelgate 后重跑一次 `skill install`，agent 手里的说明就跟 CLI 对得上。

## 许可

MIT。借鉴与致谢见英文 README 的 Prior art 一节。
