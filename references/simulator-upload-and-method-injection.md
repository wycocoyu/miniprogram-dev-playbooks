# 微信小程序后台上传卡住：页面方法与模拟器文件注入

> 适用边界：仅适用于已有明确授权的测试账号模拟器后台测试，不是通用上传授权，也不能代替手机真机手势或原生文件选择器 GUI 验收。

## 用途与原理

当自动化脚本遇到自定义组件选择器点不到、或 `wx.chooseMessageFile` 弹出系统原生文件窗口导致流程阻塞时，可以在核对页面源码、目标路由与授权范围后，通过以下两条路径完成真实业务上传链路验证：

1. **页面实例方法直调**：通过 `automation_evaluate` 获取栈顶页面实例，校验方法与当前状态后直接触发业务处理函数。
2. **一次性选择器包装注入**：提前将测试文件写入模拟器本地沙盒目录 `wx.env.USER_DATA_PATH`，在触发上传前一次性替换 `wx.chooseMessageFile` 并在回调前立即恢复原函数，后续仍由真实业务链路执行 `wx.uploadFile`。

## 先选通道，不先折腾窗口

- **保持稳定客户端身份**：使用官方 `wechatide` CLI 时固定本端 `-c <客户端名>`，不要每次换随机名称，也不要冒用其他客户端名。
- **固定前置上下文**：先锁定项目路径、版本、账号、页面路由、目标任务和弹层状态。
- **截图必关闭优化并目检**：截图指定输出路径并关闭优化，然后实际查看图片，并与状态读回交叉核验，不把“命令成功”等同于“界面正常”。

```text
# 命令模板，替换占位符并先核对本机 --help
wechatide -c <本端客户端> check_wechatide_status
wechatide -c <本端客户端> simulator_screenshot --project <项目绝对路径> --path <截图绝对路径.png> --optimize=false
```

## 常见卡点与绕过做法

### 1. `tap` 返回成功，但页面没有变化

- **做法**：操作前后必须读回页面状态；若普通 `tap` 无反应，可改用支持事件的 `trigger` 并再次读回状态确认。仍无变化时直接核对 WXML 事件绑定与 JS 处理函数，不盲目重复点击同一 selector，也不把 `trigger` 当成真实触屏验收。

### 2. 自定义组件 selector 取空，或 `page_action callMethod` 失败

- **原因**：嵌套自定义组件存在样式/节点隔离，且部分封装层无法直接定位组件内部方法。
- **绕过**：先核对源码中目标 handler 的参数与副作用，再在 `automation_evaluate` 中取 `getCurrentPages().slice(-1)[0]`，严格校验 `route`、目标任务字段以及 `typeof p.<handler> === 'function'` 后再调用，随后读回前后弹层状态确认流转完成（注意留出退场动画缓冲时间）。

### 3. 文本输入框看起来填了，保存却未落地

- **做法**：先查源码确认提交时机（如是否依赖 `blur`、picker `change` 或页面返回触发保存）。不要只在 `input` 后截图就宣称保存成功，应结合读回接口或返回上一页后再次确认。

### 4. 原生文件选择窗口阻塞后台自动化

直接触发 `wx.chooseMessageFile` 会拉起系统原生文件选择器等待人工点选。通过把测试 PDF 写入模拟器用户目录，并做一次性函数包装即可绕开弹窗，同时保留真实 `wx.uploadFile` 网络上传。

```javascript
// 安全模板：使用前先核对当前页面源码中的 route、字段名与上传 handler
const p = getCurrentPages().slice(-1)[0];
if (!p || p.route !== EXPECTED_ROUTE ||
    p.data.uploadTargetTaskKey !== EXPECTED_TASK ||
    typeof p.onChooseWechatFile !== 'function') {
  throw new Error('wrong target');
}

const file = wx.env.USER_DATA_PATH + '/qa-test-only.pdf';
const fs = wx.getFileSystemManager();
fs.writeFileSync(file, TEST_ONLY_PDF_BASE64, 'base64');

const original = wx.chooseMessageFile;
const restore = () => Object.defineProperty(wx, 'chooseMessageFile', {
  configurable: true,
  writable: true,
  value: original,
});

Object.defineProperty(wx, 'chooseMessageFile', {
  configurable: true,
  writable: true,
  value: function (opts) {
    restore(); // 回调触发前立即恢复原函数，避免污染后续选择
    opts.success({
      tempFiles: [{ path: file, name: 'qa-test-only.pdf', size: TEST_FILE_BYTES, type: 'file' }],
      errMsg: 'chooseMessageFile:ok',
    });
  },
});

// 复核完目标路由与授权范围后执行：
// p.onChooseWechatFile();
// 执行后校验 wx.chooseMessageFile === original（异常或未消费包装时显式调 restore()）
// 待上传结束且日志/页面读回完成后，再执行 fs.unlinkSync(file) 清理临时文件
```

> 若拆成多次 `evaluate` 调用，无法指望前一次调用的局部变量在后一次依然存在，需显式保存恢复句柄或在同一脚本内同步完成包装与触发。

### 5. `evaluate` 跨页面等待超时或嵌套数组异常

- **跨页面 `await` 超时**：若在 `evaluate` 里 `await` 一个会触发 `navigateTo` / `redirectTo` 的方法，原页面上下文销毁会导致求值超时。应改为同步触发，再另起一次 `evaluate` 读取新页面栈和状态。
- **嵌套数组 `setData` 异常**：在 `evaluate` 中构造带空数组字段的嵌套对象直接喂给 `setData` 时，部分基础库版本可能因 Proxy 代理触发异常；优先走真实业务事件或细粒度点路径更新。

## 上传结果必须分层判定

严禁只看到方法启动就宣称上传成功，必须按以下四层逐级核验：

| 层级 | 判定依据 | 不能替代的边界 |
| --- | --- | --- |
| **1. 文件选择注入** | 沙盒文件写入成功、一次性回调消费后 `wx.chooseMessageFile === original` | 不代表系统原生选择器 GUI 通过 |
| **2. 真实网络上传** | 上传网关日志出现实际字节数、上传接口路径、HTTP `200` 与返回 `documentId` | 不代表业务表单保存或审核通过 |
| **3. 页面状态读回** | 页面列表 `count` 递增、文件名匹配、`uploading` 状态清空 | 仅代表前端拿到返回并完成渲染 |
| **4. 视觉与真机** | 截屏肉眼确认可见「已上传」状态与文件名 | 不代表手机真机触屏交互通过 |

## 清理边界

- 上传与读回验证结束后，恢复包装函数并仅删除本次写入 `wx.env.USER_DATA_PATH` 的临时测试文件。
- 保留项目原有依赖目录（如 `miniprogram_npm`）与用户原有窗口状态，不顺手清理其他无关测试记录或进程。
