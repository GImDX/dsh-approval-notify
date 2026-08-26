# dsh-approval-notify

DeepSeek Harness (DSH) 的 Windows 桌面通知插件:当 Agent 需要你关注时,发送系统横幅通知并闪烁 Edge 任务栏图标。

- **审批提醒** 🔐:监听 `approval/asked` 会话事件(沙箱提权等操作等待批准)
- **提问提醒** ❓:监听 `ask_user_question` 工具调用,提取问题文本作为正文
- **回合完成提醒** ✅:监听 `turn/end` 事件(完成/出错/超限/取消/中断),**正文为本回合的实际输出摘要**(无输出时回退为原因文案);子代理回合与 /goal 自动推进回合默认静默(目标完成/阻塞的最终回合除外)
- **前台静默** 🚫:DSH 页面在前台时整体跳过(用户已能看到页面内的审批/提问 UI),只有页面在后台时才通知
- **Edge 闪烁**:任务栏图标持续闪烁直到你切回 DSH 页面

## 文件

| 文件 | 说明 |
|---|---|
| `approval-notify.mjs` | 插件本体(宿主进程侧,零运行时依赖) |
| `dsh-notify-icon.png` | 通知图标(DSH 徽章,214×120) |

## 许可

[MIT](LICENSE)。图标 `dsh-notify-icon.png` 来源于
`@deepseek-ai/dsh-skill-badge`(MIT,Copyright (c) 2026 DeepSeek)。

## 安装

把两个文件复制到 profile 目录,并在 `$DSH_HOME/profiles/web/cordis.patch.yml` 追加登记行:

```yaml
# System toast on every approval ask; observe-only, never answers the request.
# The ?rev query forces a fresh module import on live reload.
- insert:
    - id: approval-notify
      name: ./approval-notify.mjs
```

该补丁文件被运行中的 DSH 热监视,保存后立即生效(修改 `?rev` 数值可强制重载模块),无需重启。

> 也可以让补丁行直接引用本仓库文件的绝对路径
> (`name: C:/path/to/dsh-approval-notify/approval-notify.mjs`,替换为你的实际路径),
> 实现"改仓库即改线上"的单一来源模式;代价是路径移动后需同步修改补丁行。

## 依赖

- Windows PowerShell 5.1(系统自带)
- BurntToast 模块(**可选**):仅在通知身份快捷方式缺失时用于自动创建;主通知通道不依赖它
- 首次运行会自动注册通知应用身份 `DshNotify.App`(开始菜单快捷方式 + HKCU 注册表,无需管理员)

## 配置与定制

- **标题**:`apply()` 内 `showToast("DeepSeek Harness 需要你的审批", ...)` 与
  `notifyWithGate("DeepSeek Harness 需要你的回答", ...)`
- **图标**:直接替换同目录的 `dsh-notify-icon.png`
- **前台静默判定**:标题含 `DSH|DeepSeek|Harness` 的 msedge 窗口是否为前台窗口
  (`checkDshForeground()`);判定失败按"非前台"处理(故障开放,保证不漏通知)

## 诊断

日志: `$DSH_HOME/logs/approval-notify.log`(挂载、触发、前台判定、toast 与闪烁各阶段)

## 部署踩坑记录(重要,勿改回)

- **不可用 `detached: true` 启动 PowerShell**:PS 5.1 在 DETACHED_PROCESS 下启动后
  不执行任何脚本即退出(exit 0),表现为"发不出去"。
- **通知子进程必须使用可见控制台**:隐藏窗口(含 `-WindowStyle Hidden`、`windowsHide: true`)
  的进程发出的 toast 会被 Windows 静默丢弃;代价是每次通知有约 1.5 秒的控制台闪现。
- **PS 5.1 脚本文件必须 UTF-8 带 BOM**,否则中文乱码。
- **旧 "Windows PowerShell" AUMID 的 toast 在此类机器上会被平台接收但永不呈现**
  (BurntToast 1.1.0 默认也走该身份);必须使用新建的应用身份 `DshNotify.App`。
- **`Show()` 之后进程需存活约 1.5 秒**,否则平台来不及完成呈现。
- 通知身份快捷方式缺失时的兜底通道:BurntToast → 旧 WinRT;两条均为尽力而为。

## 版本历史

- rev=20:全新 `DshNotify.App` 身份、全称标题、徽章图标(呈现问题根治版)
- rev=21:DSH 页面在前台时静默跳过
- rev=22:新增 `ask_user_question` 提问通知
- rev=23:新增 `turn/end` 回合完成通知(子代理与 goal 自动推进回合静默)
- rev=24:回合完成通知正文改为回合实际输出摘要(150 字截断,无输出回退原因文案)
