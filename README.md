# OpenZhangXueFeng 🎓

跟 AI 张雪峰唠嗑 — 支持文字聊天、语音回复、实时通话。

张雪峰（1984–2026），考研名师、高考志愿填报专家。本项目基于其生前公开言论构建人格系统，通过 DeepSeek + Fish Audio + LangSearch 还原他的思维与表达。

100% vibe coding，由 DeepSeek-V4-Pro + Claude Code 制作。

## 功能

- **💬 文字对话** — 流式输出，Markdown 渲染（标题/列表/引用/横线/链接/图片）
- **🎤 语音回复** — Fish Audio TTS 逐句合成，流式播放，可随时打断
- **📞 语音通话** — Fish Audio ASR 识别，张雪峰语音回复，内容同步到聊天
- **🤖 Agent 搜索** — LLM 自主决定是否搜索、搜什么、搜几次（Tool Calling）
- **📎 引用标注** — 搜索结果编号，角标点击跳转原文，hover 显示详情
- **📝 对话管理** — 侧边栏历史列表，JSON 持久化，切换/删除
- **🛑 停止生成** — 文字/语音模式均可中途打断

## 快速开始

### 环境

- Python 3.10+
- Chrome / Edge（语音功能需要）

### 安装

```bash
git clone https://github.com/xiaojiang233/OpenZhangXueFeng.git
cd OpenZhangXueFeng
pip install -r requirements.txt
```

### 配置

```bash
cp .env.example .env
```

编辑 `.env`：

```env
DEEPSEEK_API_KEY=sk-...       # https://platform.deepseek.com
FISH_AUDIO_API_KEY=...        # https://fish.audio
FISH_AUDIO_VOICE_ID=...       # Fish Audio 音色 ID
LANGSEARCH_API_KEY=...        # https://langsearch.com
```

### SSL 证书（手机端语音通话必须）

手机浏览器要求 HTTPS 才给麦克风权限。项目自带一键生成：

```bash
# 生成自签名证书（替换 192.168.x.x 为你的局域网 IP）
openssl req -x509 -newkey rsa:2048 -keyout cert.key -out cert.pem \
  -days 365 -nodes \
  -subj "//CN=192.168.x.x" \
  -addext "subjectAltName=IP:192.168.1.8,IP:127.0.0.1,DNS:localhost"
```

服务器启动时检测到 `cert.key` + `cert.pem` 自动启用 HTTPS。

> 自签名证书浏览器会提示「不安全」，点「高级 → 继续访问」即可。

### 启动

```bash
python server.py
# 有证书 → https://192.168.1.8:8000
# 无证书 → http://localhost:8000
```

## 使用

| 操作   | 方式                    |
| ---- | --------------------- |
| 发送消息 | 输入框打字，Enter 发送        |
| 语音回复 | 点击顶部 🎤 切换到语音模式       |
| 语音通话 | 点击 📞 ，点麦克风说话，再点停止    |
| 新对话  | 侧边栏「+ 新对话」            |
| 切换对话 | 点击侧边栏对话项              |
| 删除对话 | 悬停对话项，点 ×             |
| 停止生成 | 处理中点击红色 ■ 按钮          |
| 打断语音 | 发送新消息自动停止当前 TTS       |
| 引用跳转 | 点击消息中 [1] 角标，新标签页打开原文 |

## 项目结构

```
OpenZhangXueFeng/
├── server.py              # FastAPI + WebSocket 服务端
├── config.py              # 环境变量配置
├── deepseek_client.py     # LLM Agent（Tool Calling）
├── fish_audio_client.py   # TTS + ASR 客户端
├── langsearch_client.py   # LangSearch 搜索
├── tts_utils.py           # TTS 文本清洗 + 引用过滤
├── storage.py             # 对话 JSON 持久化
├── SKILL.md               # 张雪峰人格定义
├── static/
│   ├── index.html         # 前端页面
│   ├── style.css          # 样式
│   └── app.js             # 前端逻辑
├── requirements.txt
└── .env.example
```

## 技术栈

| 组件  | 技术                                  |
| --- | ----------------------------------- |
| 框架  | FastAPI + Uvicorn                   |
| 通信  | WebSocket                           |
| LLM | DeepSeek V4（OpenAI 兼容，Tool Calling） |
| TTS | Fish Audio HTTP API（PCM）            |
| ASR | Fish Audio（msgpack）                 |
| 搜索  | LangSearch                          |
| 前端  | 原生 HTML/CSS/JS                      |
| 音频  | Web Audio API                       |
| 存储  | JSON 文件                             |

## 引用机制

- LLM 自主搜索，结果编号 [1][2]...，支持多轮多次搜索
- 对话内全部引用累加存储，跨回合可引用
- 每条消息仅展示本条实际引到的角标
- 角标 hover 显示标题 + URL + 摘要，点击新标签页打开

## 鸣谢

- **[zhangxuefeng-skill](https://github.com/alchaincyf/zhangxuefeng-skill)** — 张雪峰人格系统
- **[DeepSeek](https://www.deepseek.com/)** — 大语言模型
- **[Fish Audio](https://fish.audio/)** — 语音合成与识别
- **[LangSearch](https://langsearch.com/)** — 网络搜索
- [FastAPI](https://github.com/fastapi/fastapi) · [Uvicorn](https://github.com/encode/uvicorn) · [OpenAI SDK](https://github.com/openai/openai-python) · [HTTPx](https://github.com/encode/httpx) · [msgpack](https://github.com/msgpack/msgpack-python)

## License

MIT
