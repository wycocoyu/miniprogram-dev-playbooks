# 小程序真机截图自动化标注与脱敏图解手册制作指南

> **适用范围**：面向微信小程序、H5 及客户端应用的业务全流程图解手册制作、操作步骤指南生成、敏感信息脱敏与产物归档。通过将人工排版与修图转化为「微信开发者工具 CLI 原生驱动 + 清单配置 + 几何防遮挡渲染引擎 + 自动化门禁测试」的标准工业流水线，保障全流程操作指引的准确性、高对比度与视觉一致性。
> **重测支持**：本指南提供完整的重新回归测试与全流程重新跑通步骤，任何新版本发版、UI 调整或文字更新均可一键重跑校验。

---

## 一、为什么需要工程化制作流水线

在日常研发与交付中，产品手册或操作图解通常依赖人工截图并用截图工具圈选，这种方式存在四个致命缺陷：
1. **尺寸失真与视觉风格割裂**：不同设备、不同人截取的图片宽高比、缩放率不一致，拼接成手册后观感极度粗糙。
2. **脱敏流于表面引发合规风险**：人工使用马赛克或模糊工具时，常遗漏真实姓名、手机号、邮箱或后台测试标识，甚至仅在图层上方叠加半透明蒙版，底层像素仍可被反向提取。
3. **标注遮挡关键操作区域**：人工添加文字说明时，文本气泡极易挡住小程序本身的按钮、文案或导航胶囊，读者难以还原真实操作上下文。
4. **后期维护与版本更新成本极高**：小程序 UI 或文案一旦微调，整套手册必须推倒重截、重画，无法做到增量与差分更新。

本指南所沉淀的流水线将标注过程完全**代码化、数据化与流水线化**，做到底图标准化、物理像素级脱敏、几何级零遮挡防线与一键构建编译。

---

## 二、标准流水线架构图

```
+-------------------------------------------------------------+
| 1. 微信开发者工具 CLI / wechatide 受控驱动                     |
|    - 页面定向路由 (navigateTo / switchTab / reLaunch)         |
|    - 运行时 DOM / 状态注入脱敏 (automation_evaluate)          |
|    - 原生模拟器高清截屏 (simulator_screenshot)                 |
+-------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------+
| 2. 底图物理脱敏与标准化管道 (Python / Pillow)                  |
|    - 宽度统一约束为 750px (Lanczos 高保真重采样)                |
|    - 关键字段像素级重绘覆写 (替换姓名、邮箱、擦除调试悬浮球)      |
|    - 彻底剥离 PNG 元数据辅助块 (EXIF、时间戳、设备指纹)          |
+-------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------+
| 3. 结构化标注清单 (annotations/manifest.json)                |
|    - 页面 ID、章节归属、步骤序号与顶栏文案                     |
|    - 操作点红框 (#E53935) 与核对区橙框 (#D97706) 坐标         |
|    - 气泡文案、建议落点与箭头起止端点声明                      |
+-------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------+
| 4. 几何防遮挡渲染引擎 (annotate-screenshots.mjs)             |
|    - 画布向上延展 72px 独立引导顶栏 (绝不遮挡原生导航与胶囊)    |
|    - 双通渲染：底框与带白边实心箭头 -> 高对比白底文字气泡与序号标 |
|    - 动态箭头端点角度与三角多边形数学计算                      |
+-------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------+
| 5. 三道硬性自动化测试防线 (--verify)                         |
|    - Gate 1: 底图 SHA-256、750px 宽度与干净 Chunk 检验      |
|    - Gate 2: 气泡与目标红框重叠面积严格为 0 (零遮挡算法)       |
|    - Gate 3: Markdown / HTML 与 Manifest 图文一致性核验      |
+-------------------------------------------------------------+
```

---

## 三、依赖工具与环境准备

在开始执行或重新跑全流程前，请确保宿主机满足以下环境与工具链依赖：

### 3.1 微信开发者工具 CLI (`wechatide`)
- **macOS 默认安装路径**：`/Applications/wechatwebdevtools.app/Contents/MacOS/wechatide`
- **开发者工具安全配置**：必须在微信开发者工具设置中开启服务端口（`设置 -> 安全设置 -> 服务端口: 开启`）。
- **客户端认证协议**：通过 `-c Antigravity` 免密与正在运行的开发工具通信。

### 3.2 运行环境与核心类库
- **Node.js**：`v18+`（推荐 `v20` 或 `v24`，原生支持 ES Modules）。
- **Python**：`3.10+`，安装有图像处理库 `Pillow`（或通过 `uv run --with pillow python3` 零配置即开即用）。
- **系统内置字体**：依赖高保真苹方中文字体（`/System/Library/Fonts/PingFang.ttc`），若在 Linux CI 上运行，需指定中文字体包（如 `fonts-wqy-zenhei`）。

---

## 四、各阶段详细操作规程与核心命令

### 阶段 1：受控真机截屏与运行时脱敏

使用微信开发者工具官方 CLI 进行驱动，严禁手动拖拽窗口截屏，确保每一帧的机型与像素比绝对可控。

#### 1.1 常用 CLI 指令与参数避坑
- **避免首屏覆写**：若模拟器窗口已经处于打开状态，严禁重复调用 `open_project_window`，否则冷启动重载逻辑会覆盖正在执行的深层跳转。应直接调用 `automation_navigate`：
  ```bash
  PROJ="/path/to/miniprogram"
  CLI="/Applications/wechatwebdevtools.app/Contents/MacOS/wechatide"

  # 直接路由到目标页面（根据页面类型选择 navigateTo / switchTab / reLaunch）
  "$CLI" -c Antigravity automation_navigate --project "$PROJ" --action navigateTo --url "/pages/detail/index?id=123"
  ```

#### 1.2 运行时状态注入脱敏
对于已登录或动态渲染的真实用户信息，在截屏前直接调用 `automation_evaluate` 篡改当前活跃页面的数据模型，将真实数据替换为标准示例占位符：
```bash
"$CLI" -c Antigravity automation_evaluate --project "$PROJ" --fn-source "() => {
  const pages = getCurrentPages();
  const p = pages[pages.length - 1];
  if (p && p.setData) {
    p.setData({
      userDisplayName: '张同学（示例）',
      userEmail: 'student_demo@example.com',
      mobile: '138****0000'
    });
  }
}"
```

#### 1.3 截取原始高清图
```bash
"$CLI" -c Antigravity simulator_screenshot --project "$PROJ"
# 从返回的 JSON 中提取临时图片路径 (如 /var/folders/.../wechatide-simulator-screenshot-xxx.jpg) 并拷贝到暂存区
```

---

### 阶段 2：底图标准化与物理像素级脱敏

无论图片来自开发者工具模拟器截屏还是历史实测归档，进入工程前必须全部通过标准化预处理。

#### 2.1 规范要求
1. **画布统一为 750px 宽**：对应小程序设计稿的 `750rpx` 基础尺寸，方便精准量取 CSS 与组件边界。
2. **物理覆写（In-Place Pixel Repaint）**：用背景底色将敏感字符完全填充，并在同位置绘制虚拟示例字样。
3. **彻底剥离 Metadata**：新建空白 RGB 图像对象后粘贴，剥离源文件中的敏感 Chunk（如 GPS、创建设备、修改时间戳等）。

#### 2.2 核心处理脚本（Python + Pillow）
```python
import os
from PIL import Image, ImageDraw, ImageFont

def standardize_and_redact(src_path, dst_path, redact_list=None):
    im = Image.open(src_path).convert("RGB")
    w, h = im.size
    
    # 1. 统一 750px 宽度等比缩放 (Lanczos 高保真重采样)
    target_w = 750
    target_h = int(round(h * (target_w / w)))
    if (w, h) != (target_w, target_h):
        im = im.resize((target_w, target_h), Image.Resampling.LANCZOS)
    
    draw = ImageDraw.Draw(im)
    font = ImageFont.truetype("/System/Library/Fonts/PingFang.ttc", 22)
    
    # 2. 物理覆写敏感区域
    if redact_list:
        for item in redact_list:
            x, y, rw, rh = item["x"], item["y"], item["w"], item["h"]
            fill_color = item.get("fill", (255, 255, 255))
            draw.rectangle([x, y, x + rw, y + rh], fill=fill_color)
            if "text" in item:
                text_color = item.get("text_color", (30, 41, 59))
                draw.text((x + 4, y + 6), item["text"], fill=text_color, font=font)
    
    # 3. 剥离 metadata 导出为干净 PNG
    clean_im = Image.new("RGB", im.size)
    clean_im.paste(im)
    clean_im.save(dst_path, format="PNG", optimize=True)
```

---

### 阶段 3：声明式标注清单结构（`manifest.json`）

通过单一数据源定义整套手册的所有标注物，与具体代码逻辑彻底解耦。

#### 3.1 字段规范与坐标契约
```json
{
  "schemaVersion": "1.0.0",
  "canvasWidth": 750,
  "topBannerHeight": 72,
  "items": [
    {
      "id": "ch09-s23-02-detail-pause-btn",
      "chapterId": "ch09",
      "scenarioId": "S23",
      "stepIndex": 2,
      "title": "在申请详情抽屉底部点击常驻「暂停申请」按钮",
      "headerBanner": "在申请详情抽屉底部点击常驻「暂停申请」按钮",
      "rawPath": "screenshots/raw/ch09-s23-02-detail-pause-btn.png",
      "annotatedPath": "screenshots/annotated/ch09-s23-02-detail-pause-btn.png",
      "rawSha256": "4b92bfa...",
      "annotations": [
        {
          "step": 1,
          "kind": "verify",
          "box": { "x": 136, "y": 912, "w": 574, "h": 302, "rx": 12 },
          "badge": { "cx": 158, "cy": 890, "r": 20 },
          "arrow": { "x1": 423, "y1": 830, "x2": 423, "y2": 906 },
          "callout": {
            "x": 45,
            "y": 730,
            "w": 660,
            "h": 88,
            "rx": 12,
            "text": "① 核对时间轴处于「申请进行中」",
            "subtext": "专属邮箱与收件箱入口正常展示"
          }
        },
        {
          "step": 2,
          "kind": "action",
          "box": { "x": 38, "y": 1390, "w": 674, "h": 96, "rx": 12 },
          "badge": { "cx": 60, "cy": 1368, "r": 20 },
          "arrow": { "x1": 375, "y1": 1340, "x2": 375, "y2": 1384 },
          "callout": {
            "x": 45,
            "y": 1240,
            "w": 660,
            "h": 88,
            "rx": 12,
            "text": "② 点击抽屉底部常驻灰色「暂停申请」按钮",
            "subtext": "按红框指引单次点击即可（无需长按）"
          }
        }
      ]
    }
  ]
}
```

- **视觉色彩约定**：
  - `kind: "action"`（用户操作点）：描边使用亮红 `#E53935`。
  - `kind: "verify"`（状态/结果核对区）：描边使用琥珀橙 `#D97706`。
  - `kind: "verify_green"`（成功就绪态）：描边使用翠绿 `#16A34A`。
  - **白边包裹**：所有高亮框与箭头外层均增加 2~3px 纯白描边，确保在任何深色、浅色或杂乱渐变背景下均清晰醒目。

---

### 阶段 4：几何防遮挡渲染引擎设计

标注渲染脚本通过对原图在垂直维度向上扩展 `72px`，彻底杜绝了传统标注顶栏遮挡原生小程序导航栏的问题。

#### 4.1 关键算法：箭头向量计算与带白边实心多边形
```javascript
// 箭头向量数学计算 (Node.js / Python 通用逻辑)
function drawArrow(ctx, x1, y1, x2, y2, color, arrowLength = 22, arrowAngle = Math.PI / 6) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const angle = Math.atan2(dy, dx);

  // 箭身主线
  const bx = x2 - Math.cos(angle) * (arrowLength * 0.7);
  const by = y2 - Math.sin(angle) * (arrowLength * 0.7);

  // 绘制 7px 粗白底衬（防融色）
  ctx.drawLine(x1, y1, bx, by, { width: 7, color: '#FFFFFF' });
  // 绘制 4px 主题色线
  ctx.drawLine(x1, y1, bx, by, { width: 4, color: color });

  // 箭头三角形三个顶点
  const p1 = [x2, y2];
  const p2 = [
    x2 - arrowLength * Math.cos(angle - arrowAngle),
    y2 - arrowLength * Math.sin(angle - arrowAngle)
  ];
  const p3 = [
    x2 - arrowLength * Math.cos(angle + arrowAngle),
    y2 - arrowLength * Math.sin(angle + arrowAngle)
  ];

  // 绘制实心带白边三角形
  ctx.drawPolygon([p1, p2, p3], { fill: color, outline: '#FFFFFF', outlineWidth: 2 });
}
```

#### 4.2 双通道绘制顺序（确保图层层级正确）
1. **Pass 1（底层通道）**：绘制目标控件外轮廓高亮框（带外层白色扩充边）以及方向连接箭头。
2. **Pass 2（顶层通道）**：绘制带投影效果的半透明白底文字气泡卡片，以及带有序号数字的圆形 Badge。保证文字和编号永远在最上层，不会被箭头或框线穿透。

---

### 阶段 5：三道硬性自动化测试防线（Verification Gates）

在交付前，必须运行自动化测试命令（`node scripts/annotate-screenshots.mjs --verify`），全部为 0 报错才允许归档与提交。

#### 5.1 门禁定义与执行逻辑
- **Gate 1（底图物理规格门禁）**：
  - 检查每一个 `rawPath` 是否存在且宽度恰好为 `750px`。
  - 计算文件 SHA-256 并与 `manifest.json` 核对，防止图片被意外修改或损坏。
  - 扫描图片结构，确保无遗留的临时元数据或敏感 Tag。
- **Gate 2（零遮挡几何检测门禁）**：
  - 遍历所有条目，运行矩形重叠面积算法：
    $$\text{OverlapArea} = \max(0, \min(x_{2a}, x_{2b}) - \max(x_{1a}, x_{1b})) \times \max(0, \min(y_{2a}, y_{2b}) - \max(y_{1a}, y_{1b}))$$
  - **断言：气泡矩形与自身或同图其他操作红框的重叠面积必须严格等于 0**。若计算大于 0，说明气泡遮挡了操作按钮，构建立即失败中断。
- **Gate 3（文档一致性与治理门禁）**：
  - 校验 Markdown 文档与编译出的 HTML 文件中，所有引用的图片链接是否在磁盘上完全存在。
  - 核查手册是否包含必要的场景速查表、边界治理表及走查记录模版。

---

## 五、基于最新版本重新跑通与回归测试 SOP

当小程序代码有新发布、页面增加新字段或需要重新走查全流程图解手册时，请严格按以下步骤执行端到端重测：

```
+--------------------------------------------------------------+
| 步骤 1: 准备最新小程序环境                                      |
|   - 确认微信开发者工具加载目标分支最新代码                        |
|   - 模拟器打开并登录最新测试账号                               |
+--------------------------------------------------------------+
                              |
                              v
+--------------------------------------------------------------+
| 步骤 2: 重新截取变动的页面截屏                                  |
|   - 运行 wechatide automation_navigate 跳转至变动页面          |
|   - 运行 automation_evaluate 注入脱敏数据                      |
|   - 截取新底图输出至临时目录                                    |
+--------------------------------------------------------------+
                              |
                              v
+--------------------------------------------------------------+
| 步骤 3: 物理标准化并更新 raw 目录                              |
|   - 运行 standardize_and_redact 缩放为 750px 宽并擦除调试浮标   |
|   - 覆盖更新至 screenshots/raw/<目标文件>.png                  |
+--------------------------------------------------------------+
                              |
                              v
+--------------------------------------------------------------+
| 步骤 4: 更新哈希并重新生成标注图与手册                          |
|   - node scripts/annotate-screenshots.mjs --update-hashes   |
|   - node scripts/annotate-screenshots.mjs --build-images    |
|   - node scripts/annotate-screenshots.mjs --build-docs      |
+--------------------------------------------------------------+
                              |
                              v
+--------------------------------------------------------------+
| 步骤 5: 运行三门禁自动化测试                                    |
|   - node scripts/annotate-screenshots.mjs --verify          |
|   - 断言: Gate 1, Gate 2, Gate 3 全部 PASSED (退出码 0)      |
+--------------------------------------------------------------+
```

### 5.1 快速重测一条龙命令
在目标图解手册目录（配合脚本 [`../scripts/annotate-screenshots.mjs`](../scripts/annotate-screenshots.mjs)）下一键执行：
```bash
# 1. 刷新 raw 图片哈希值（若替换了底图）
node scripts/annotate-screenshots.mjs --update-hashes

# 2. 重新编译生成所有 35 张带标注图片
node scripts/annotate-screenshots.mjs --build-images

# 3. 重新将 Markdown 原稿编译为离线 HTML 手册
node scripts/annotate-screenshots.mjs --build-docs

# 4. 跑全量三道门禁校验
node scripts/annotate-screenshots.mjs --verify
```
**合格判据**：终端输出以下两行且退出码为 `0`：
```text
Gate 1 & Gate 2 passed: 35 raw + 35 annotated PNGs verified (SHA-256, 750px width, clean chunks, zero occlusion).
Gate 3 passed: All 24 scenario cards, 35 image links, 4 governance tables, and honest review status verified.
```

---

## 六、实战避坑速查表

| 场景 / 现象 | 根因分析 | 推荐解决方案 |
|---|---|---|
| **页面跳转被冷启动覆盖** | 连续调用 `open_project_window` 与 `automation_navigate` 时，前者的异步初始化完成时会自动重定向到首页 | 仅在首次拉起时打开工程，后续截屏复用已有 `winId` 直接调用 `automation_navigate` |
| **红框融入页面背景看不清** | 小程序部分卡片本身为浅黄或红色背景，单色红框对比度不足 | 高亮框必须绘制**双层轮廓**：外层绘制 7px 白色底框，内层绘制 4px 主题色框 |
| **提示文字遮挡操作目标** | 目标按钮靠底边时，气泡默认向下排布导致溢出或盖住按钮 | 编写碰撞检测探针，当控件靠近屏幕底部（$y > 1100$）时，气泡强制排布在控件上方，箭头由下往上指 |
| **顶部横幅截断原生胶囊** | 直接在原截图顶部加半透明条覆盖了小程序的右上角三个点胶囊按钮 | 渲染时通过 `Image.new('RGBA', (750, H + 72))` 将画布整体向下平移，顶部 72px 专设为指引条 |
| **脱敏信息泄露** | 仅用毛玻璃效果或马赛克，数字或字母轮廓仍可辨识 | 严禁模糊滤镜，必须用取样背景色画纯色色块，并用清晰标准字体覆写 `student_demo@example.com` 等假数据 |
| **自动化测试报重叠碰撞** | UI 调整后按钮位置下移，与预设的气泡矩形产生交叠 | 运行防重叠自动校正脚本，自动在垂直方向向上/向下搜索无碰撞区域并自适应调整箭头端点 |

---

## 七、产物归档规范

根据团队规范，所有涉及图解手册的产物必须统一在需求目录下闭环管理：
1. **底图归档**：原始标准图入 `screenshots/raw/*.png`。
2. **成品归档**：标注完成图入 `screenshots/annotated/*.png`。
3. **数据清单**：配置清单入 `annotations/manifest.json`。
4. **编译产物**：必须同时生成同名的 `.md` 与离线可直接双击查看排版的 `.html`。
5. **严禁遗留暂存区**：验证通过后，临时暂存目录（如 `scratch/raw_staging/`）必须彻底清理，保证仓库整洁。
