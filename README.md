# miniprogram-dev-playbooks

微信小程序工程化联调、真机调试、自动化截屏脱敏标注与模拟器交互绕过 Skill。

## 目录结构

```text
miniprogram-dev-playbooks/
├── SKILL.md                                           # Skill 主入口（方法摘要与路由）
├── references/
│   ├── local-and-real-device-integration.md           # 本地后端单接口分流与手机真机联调方法
│   ├── screenshot-annotation-and-redaction.md         # CLI 截屏、Pillow 脱敏与零遮挡标注流水线
│   └── simulator-upload-and-method-injection.md       # 模拟器页面方法触发与文件选择注入规程
└── scripts/
    └── annotate-screenshots.mjs                       # 通用防遮挡标注渲染、HTML 编译与校验脚本
```

## 安装与使用

### 方式一：本地软链到 Agent Skills 目录

```bash
ln -sfn /path/to/miniprogram-dev-playbooks ~/.gemini/config/skills/miniprogram-dev-playbooks
ln -sfn /path/to/miniprogram-dev-playbooks ~/.agents/skills/miniprogram-dev-playbooks
ln -sfn /path/to/miniprogram-dev-playbooks ~/.claude/skills/miniprogram-dev-playbooks
```

### 方式二：直接阅读方法入口

查看 [SKILL.md](SKILL.md) 或 `references/` 下的对应专题指南。
