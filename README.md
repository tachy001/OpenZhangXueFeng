# OpenZhangXueFeng

一个围绕专业选择、升学与职业规划的 AI 咨询工作台。根据公开表达构建的人格参考由 `SKILL.md` 提供，回答由 DeepSeek 生成，支持 LangSearch 搜索和 Fish Audio 语音。

## 功能

- 流式文字对话、Markdown 和可点击的来源引用。
- 可中途停止生成，切换或删除会话会取消对应的生成与语音任务。
- 历史会话本地保存，支持搜索、切换和删除。
- 语音回复与录音通话，文字与语音同步到同一会话。
- 适配桌面和手机的咨询界面，支持浅色与深色主题。
- 服务状态检测：未配置密钥时仍可打开界面、管理历史，分别提示不可用的能力。

## 启动

需要 Python 3.10+。语音录制需要 Chrome / Edge 等支持麦克风的浏览器。

```bash
python -m venv .venv
```

Windows PowerShell：

```powershell
.\.venv\Scripts\Activate.ps1
Copy-Item .env.example .env
pip install -r requirements.txt
python server.py
```

macOS / Linux：

```bash
source .venv/bin/activate
cp .env.example .env
pip install -r requirements.txt
python server.py
```

打开 [本地工作台](http://localhost:8000)。静态前端使用原生 ES Modules，无需安装 Node.js 或执行前端构建。

## 配置

编辑项目根目录的 `.env`，重新启动后生效：

| 配置 | 用途 |
| --- | --- |
| `DEEPSEEK_API_KEY` | 启用 AI 文字对话 |
| `DEEPSEEK_BASE_URL` | OpenAI 兼容接口地址，默认 `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | 默认 `deepseek-v4-pro` |
| `FISH_AUDIO_API_KEY` | 启用语音合成和识别 |
| `FISH_AUDIO_VOICE_ID` | Fish Audio 音色 ID |
| `FISH_AUDIO_LATENCY` | `normal`、`balanced` 或 `low` |
| `LANGSEARCH_API_KEY` | 启用联网搜索；未配置时使用纯文字模型回答 |
| `HOST` / `PORT` | 默认 `0.0.0.0:8000` |
| `DATA_DIR` | 会话存储目录，默认项目下的 `data/` |
| `MAX_MESSAGE_CHARS` | 单条消息上限，默认 12000 字符 |
| `MAX_UPLOAD_BYTES` | 录音上传上限，默认 20 MiB |
| `MAX_HISTORY_MESSAGES` | 每次模型请求的历史条数，默认 80 |
| `GENERATION_TIMEOUT_SECONDS` | 单轮文字生成超时，默认 180 秒 |

只配置 DeepSeek 即可文字聊天；搜索和语音可以分别启用。健康接口只报告能力是否已配置，不代表已经连接上第三方服务，也不会返回密钥。

浏览器语音播放使用 PCM、44100 Hz、16 位单声道；`FISH_AUDIO_FORMAT` 只接受 `pcm`。

### 手机录音与 HTTPS

浏览器通常只允许在 `localhost` 或 HTTPS 环境使用麦克风。项目目录同时存在 `cert.pem` 和 `cert.key` 时，`python server.py` 会自动启用 HTTPS。证书需要覆盖实际访问的域名或局域网 IP，并由设备信任。

## 项目结构

```text
server.py                  启动入口，兼容 uvicorn server:app
config.py                  类型化配置与能力状态
app/
  application.py           应用工厂、静态资源与生命周期
  routes.py                会话、健康、录音及 WebSocket 接口
  session.py               每连接的会话状态、生成和取消
  services.py              可替换的模型、搜索与音频适配器
storage.py                 JSON 会话存储及兼容接口
deepseek_client.py         流式工具调用与搜索循环
fish_audio_client.py       PCM 合成、MessagePack 语音识别
langsearch_client.py       搜索结果整理与来源编号
sentence_buffer.py         有界句子缓冲
tts_utils.py               语音文本清洗、引用筛选
static/                    无构建依赖的前端模块和样式
tests/                     不调用付费 API 的回归验证
SKILL.md                   应用使用的人格参考
```

会话仍存放在 `data/conversations/*.json`，兼容已有的 12 位十六进制 ID 和原有会话数据。采用原子替换与文件锁保护写入；索引损坏或缺失时会从有效会话文件恢复。删除会话不会自动创建替代会话。

当前会话任务协调面向单个 ASGI 进程，可同时打开多个浏览器标签页。部署时使用默认的单 worker；跨进程共享生成任务状态尚未实现。

## 接口

| 方法 | 地址 | 作用 |
| --- | --- | --- |
| GET | `/api/health` | 能力就绪状态及输入限制 |
| GET / POST | `/api/conversations` | 列出 / 新建会话 |
| GET / PATCH / DELETE | `/api/conversations/{id}` | 获取 / 重命名 / 删除会话 |
| POST | `/api/asr` | 上传 `audio` 文件进行语音识别 |
| WebSocket | `/ws` | 流式对话、引用、音频与会话命令 |

WebSocket 保留 `chat`、`stop`、`new_conv`、`load_conv`、`delete_conv` 命令，以及 `history`、`conv_active`、`conv_list`、`text_chunk`、`citations`、`status`、`audio`、`error` 事件。新前端通过请求与会话标识隔离旧任务的消息。重连会先恢复当前会话，避免自动重发产生重复回答。

## 验证

```bash
pip install -r requirements-dev.txt
python -m pytest
```

测试使用临时数据和替代服务，覆盖生成取消与清理、会话隔离、并发存储、输入验证、工具调用、引用边界和语音句子完整性。真实服务的认证、额度、音色权限和识别质量需要在配置实际密钥后验证。

可选的界面检查需要 Node.js 22+：

```bash
npm ci
npx playwright install chromium
npm run test:browser
npm run format:check
```

浏览器检查会自动启动独立的测试服务，使用临时会话和替代回答，不调用真实 AI 服务。截图保存在 `.tmp/browser-artifacts/`。若 Python 不在项目的 `.venv` 内，可通过 `TEST_PYTHON` 指定；也可通过 `BROWSER_EXECUTABLE_PATH` 使用已安装的 Chrome。Node.js 和这些开发依赖不参与正常启动。

开发时可使用自动重载：

```bash
uvicorn server:app --reload
```

## 鸣谢

[zhangxuefeng-skill](https://github.com/alchaincyf/zhangxuefeng-skill) · [DeepSeek](https://www.deepseek.com/) · [Fish Audio](https://fish.audio/) · [LangSearch](https://langsearch.com/) · [FastAPI](https://fastapi.tiangolo.com/)

## License

MIT
