# NanoClaw Web Channel Protocol

NanoClaw 作为 Agent 执行引擎的 HTTP + SSE 接口协议。

## 架构定位

```
┌─────────────────────────────────────────────────────────────┐
│                        网站 (你的项目)                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │   用户管理    │  │   技能管理    │  │   对话历史存储    │  │
│  │  认证/授权    │  │  技能选择     │  │   上下文管理      │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│                            │                                │
│                            ▼ HTTP + SSE + X-API-Key         │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                     NanoClaw (Agent 引擎)                    │
│                                                             │
│   1. 接收执行请求（prompt + context + skills）              │
│   2. 创建临时任务目录，注入技能                              │
│   3. 在容器中运行 Agent                                     │
│   4. 流式返回执行结果（SSE）                                 │
│   5. 清理临时资源                                           │
│                                                             │
│   ❌ 不存储对话历史                                         │
│   ❌ 不管理技能                                             │
│   ✅ 只负责单次 Agent 执行                                  │
└─────────────────────────────────────────────────────────────┘
```

## 认证

所有请求需包含 Header:
```
X-API-Key: {shared_secret}
```

双方在各自环境配置相同的密钥：
```bash
# NanoClaw .env
WEB_API_KEY=nanoclaw_internal_key_xxx

# 网站后端 .env
NANOCLAW_API_KEY=nanoclaw_internal_key_xxx
```

## API 端点

### POST /api/v1/execute

执行 Agent 任务，返回 SSE 流式输出。

**请求**:
```http
POST /api/v1/execute
Content-Type: application/json
X-API-Key: {shared_secret}
```

```json
{
  "user_id": "alice",
  "task_id": "task_001",
  "skills": ["browser", "file"],
  "prompt": "分析这个网站",
  "context": {
    "messages": [
      {"role": "user", "content": "之前的提问..."},
      {"role": "assistant", "content": "之前的回答..."}
    ]
  },
  "files": ["/shared/uploads/alice/data.csv"]
}
```

**字段说明**:

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `user_id` | string | 是 | 用户标识，用于目录隔离 |
| `task_id` | string | 是 | 任务标识，用于目录隔离 |
| `skills` | string[] | 否 | 需要注入的技能列表（从 skill-templates 复制） |
| `prompt` | string | 是 | 本次执行的用户提示 |
| `context.messages` | array | 否 | 历史对话，按顺序注入 prompt |
| `files` | string[] | 否 | 共享目录中的文件路径 |

**SSE 响应**:

```
data: {"type": "start", "timestamp": "2026-03-12T10:30:00Z"}

data: {"type": "content", "content": "我来分析这个网站..."}

data: {"type": "tool_start", "tool": "browser", "input": {"url": "https://example.com"}}

data: {"type": "tool_complete", "tool": "browser"}

data: {"type": "content", "content": "分析完成，发现..."}

data: {"type": "file", "path": "/shared/outputs/alice/task_001/report.md"}

data: {"type": "complete", "usage": {"duration_ms": 15000}}
```

**事件类型**:

| 类型 | 说明 |
|------|------|
| `start` | 开始执行 |
| `thinking` | Agent 思考 |
| `content` | 输出内容 |
| `tool_start` | 工具调用开始 |
| `tool_complete` | 工具调用完成 |
| `file` | 生成文件 |
| `error` | 执行错误 |
| `complete` | 执行完成 |

### GET /api/v1/skills

获取 NanoClaw 可用的技能模板列表。

**响应**:
```json
{
  "skills": [
    {"name": "browser", "description": "浏览器自动化"},
    {"name": "file", "description": "文件操作"}
  ]
}
```

网站用这个列表展示给用户选择，然后在调用 `/execute` 时传入选中的技能。

## 目录与文件

### 运行时目录结构

执行期间临时创建：
```
groups/users/{user_id}/tasks/{task_id}/
├── CLAUDE.md          # 系统提示（自动生成的，包含上下文）
├── skills/            # 复制的技能模板
│   ├── browser.md
│   └── file.md
└── uploads/           # 上传文件的软链接
    └── data.csv -> /shared/uploads/alice/data.csv
```

执行完成后清理。

### 共享卷

```yaml
# docker-compose.yml
volumes:
  shared-data:

services:
  nanoclaw:
    volumes:
      - shared-data:/shared

  website:
    volumes:
      - shared-data:/shared
```

**约定路径**:
- 上传文件: `/shared/uploads/{user_id}/{filename}`
- 输出文件: `/shared/outputs/{user_id}/{task_id}/{filename}`

## 使用流程

### 1. 网站侧管理

```typescript
// 网站负责：用户认证、技能选择、对话历史存储

// 用户选择要使用的技能
const selectedSkills = ['browser', 'file'];  // 从 GET /api/v1/skills 获取列表展示

// 网站从数据库读取对话历史
const history = await db.getHistory(userId, taskId);

// 调用 NanoClaw 执行
const response = await fetch('http://nanoclaw:8080/api/v1/execute', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': process.env.NANOCLAW_API_KEY
  },
  body: JSON.stringify({
    user_id: userId,
    task_id: taskId,
    skills: selectedSkills,  // 告诉 NanoClaw 注入哪些技能
    prompt: userInput,
    context: { messages: history },  // 传递历史对话
    files: uploadedFiles  // 传递文件路径
  })
});

// 读取 SSE 流，实时展示给用户
for await (const event of parseSSE(response.body)) {
  if (event.type === 'content') {
    appendToChat(event.content);
  } else if (event.type === 'file') {
    showFileLink(event.path);
  }
}

// 网站保存新的对话到数据库
await db.saveMessage(userId, taskId, {role: 'user', content: userInput});
await db.saveMessage(userId, taskId, {role: 'assistant', content: fullResponse});
```

### 2. NanoClaw 执行

```
1. 接收请求
2. 创建 groups/users/{user_id}/tasks/{task_id}/
3. 复制 skill-templates/{skill}.md 到 skills/
4. 生成 CLAUDE.md（包含 context.messages）
5. 创建 uploads/ 软链接
6. 启动容器执行 Agent
7. 转发容器输出为 SSE 事件
8. 清理临时目录
```

## 配置

### NanoClaw (.env)

```bash
# Web Channel
WEB_API_KEY=your_shared_secret
WEB_PORT=8080
WEB_HOST=0.0.0.0

# 共享目录
SHARED_UPLOADS_DIR=/shared/uploads
SHARED_OUTPUTS_DIR=/shared/outputs
```

### 网站后端

```bash
NANOCLAW_API_KEY=your_shared_secret
NANOCLAW_BASE_URL=http://nanoclaw:8080
```

## 边界划分

| 功能 | 网站负责 | NanoClaw 负责 |
|------|----------|---------------|
| 用户认证 | ✅ | ❌ |
| 技能展示/选择 | ✅ | 只提供列表 |
| 对话历史存储 | ✅ | ❌ |
| 上下文传递 | 通过 API 参数 | 注入 prompt |
| 文件上传/下载 | ✅ | 只访问共享路径 |
| Agent 执行 | ❌ | ✅ |
| 技能注入 | ❌ | ✅ |
| 容器管理 | ❌ | ✅ |
| SSE 流输出 | ❌ | ✅ |
