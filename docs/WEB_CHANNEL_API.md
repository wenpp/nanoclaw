# NanoClaw Web Channel API 文档

## 架构概述

```
┌─────────────────────────────────────────────────────────────┐
│                        你的网站                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │   用户管理    │  │   技能选择    │  │   对话历史存储    │  │
│  │  认证/授权    │  │  技能市场     │  │   上下文管理      │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│                            │                                │
│                            ▼ HTTP + SSE                     │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                     NanoClaw (Agent 引擎)                    │
│                                                             │
│   接收任务 → 创建临时目录 → 注入技能 → 容器执行 → SSE流输出    │
│                                                             │
│   ❌ 不存储对话历史  ❌ 不管理技能  ✅ 只负责单次执行          │
└─────────────────────────────────────────────────────────────┘
```

**核心设计原则**:
- **NanoClaw 是无状态的**：不存储对话历史，只负责单次执行
- **网站负责上下文管理**：在你的数据库中存储对话历史，通过 `context` 参数传递

---

## 认证方式

所有请求需要在 Header 中携带共享密钥：

```http
X-API-Key: {shared_secret}
```

**配置方式**:

```bash
# NanoClaw .env
WEB_API_KEY=nanoclaw_internal_key_xxx
WEB_PORT=8080

# 你的网站后端 .env
NANOCLAW_API_KEY=nanoclaw_internal_key_xxx
NANOCLAW_BASE_URL=http://localhost:8080
```

---

## API 端点

### 1. 执行任务（核心接口）

**请求**:
```http
POST /api/v1/execute
Content-Type: application/json
X-API-Key: {shared_secret}
```

**请求体**:
```json
{
  "user_id": "alice",
  "task_id": "task_001",
  "skills": ["browser", "file"],
  "prompt": "分析这个网站并生成报告",
  "context": {
    "messages": [
      {"role": "user", "content": "之前的用户问题..."},
      {"role": "assistant", "content": "之前的AI回答..."}
    ],
    "summary": "可选的上下文摘要"
  },
  "files": ["/shared/uploads/alice/data.csv"],
  "stream": true,
  "timeout": 300000
}
```

**字段说明**:

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `user_id` | string | 是 | 用户标识，用于目录隔离 |
| `task_id` | string | 是 | 任务标识，建议格式：`{类型}_{时间戳}`，如 `geo_20240312_001` |
| `skills` | string[] | 否 | 需要注入的技能列表，从 `/api/v1/skills` 获取 |
| `prompt` | string | 是 | 本次执行的用户提示 |
| `context.messages` | array | 否 | 历史对话数组，由网站存储管理 |
| `context.summary` | string | 否 | 上下文摘要，用于长对话场景 |
| `files` | string[] | 否 | 共享目录中的文件路径列表 |
| `stream` | boolean | 否 | 是否启用 SSE 流式输出，默认 `true` |
| `timeout` | number | 否 | 任务超时时间（毫秒），默认 300000 (5分钟) |

**SSE 响应流**:
```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

```text
data: {"type": "start", "user_id": "alice", "task_id": "task_001", "timestamp": "2026-03-12T10:30:00Z"}

data: {"type": "thinking", "content": "我需要先分析这个网站..."}

data: {"type": "content", "content": "我来分析这个网站..."}

data: {"type": "tool_start", "tool": "browser", "input": {"url": "https://example.com"}}

data: {"type": "tool_complete", "tool": "browser"}

data: {"type": "content", "content": "分析完成，发现以下问题..."}

data: {"type": "file", "path": "/shared/outputs/alice/task_001/report.html", "name": "report.html"}

data: {"type": "complete", "task_id": "task_001", "usage": {"duration_ms": 15000, "tokens_input": 2000, "tokens_output": 800}}
```

**SSE 事件类型**:

| 类型 | 说明 | 示例 |
|------|------|------|
| `start` | 任务开始执行 | `{"type": "start", "user_id": "...", "task_id": "...", "timestamp": "..."}` |
| `thinking` | Agent 思考过程 | `{"type": "thinking", "content": "..."}` |
| `content` | Agent 回复内容 | `{"type": "content", "content": "..."}` |
| `tool_start` | 开始调用工具 | `{"type": "tool_start", "tool": "browser", "input": {...}}` |
| `tool_complete` | 工具调用完成 | `{"type": "tool_complete", "tool": "browser"}` |
| `file` | 生成文件路径 | `{"type": "file", "path": "...", "name": "..."}` |
| `error` | 执行错误 | `{"type": "error", "message": "...", "code": "..."}` |
| `complete` | 任务完成 | `{"type": "complete", "task_id": "...", "usage": {...}}` |

---

### 2. 获取可用技能列表

**请求**:
```http
GET /api/v1/skills
X-API-Key: {shared_secret}
```

**响应**:
```json
{
  "skills": [
    {"name": "browser", "description": "浏览器自动化"},
    {"name": "file", "description": "文件操作工具"},
    {"name": "geo", "description": "SEO优化工具"}
  ]
}
```

**用途**: 在你的网站上展示技能市场，让用户选择要使用的技能。

---

## 典型使用场景

### 场景1：用户发起新对话

```typescript
// 1. 生成新的 task_id
const taskId = `task_${Date.now()}`;

// 2. 用户选择技能（从 /api/v1/skills 获取列表）
const selectedSkills = ['browser', 'geo'];

// 3. 用户输入
const userInput = "帮我分析 example.com 的 SEO";

// 4. 调用 NanoClaw
const response = await fetch('http://nanoclaw:8080/api/v1/execute', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': process.env.NANOCLAW_API_KEY
  },
  body: JSON.stringify({
    user_id: userId,
    task_id: taskId,
    skills: selectedSkills,
    prompt: userInput,
    // 新对话，无需 context
    stream: true
  })
});

// 5. 处理 SSE 流
const reader = response.body.getReader();
const decoder = new TextDecoder();
let fullResponse = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const chunk = decoder.decode(value);
  const lines = chunk.split('\n');

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const event = JSON.parse(line.slice(6));

      switch (event.type) {
        case 'content':
          fullResponse += event.content;
          updateChatUI(event.content); // 实时更新UI
          break;
        case 'file':
          showFileLink(event.path); // 显示生成的文件
          break;
        case 'complete':
          console.log('任务完成', event.usage);
          break;
      }
    }
  }
}

// 6. 保存对话到数据库
await db.saveMessage(userId, taskId, {role: 'user', content: userInput});
await db.saveMessage(userId, taskId, {role: 'assistant', content: fullResponse});
```

### 场景2：继续已有对话

```typescript
// 1. 从数据库读取对话历史
const history = await db.getConversationHistory(userId, taskId);
// history: [
//   {role: 'user', content: '帮我分析 example.com 的 SEO'},
//   {role: 'assistant', content: '好的，我正在分析...'}
// ]

// 2. 用户新输入
const userInput = "再帮我检查一下关键词密度";

// 3. 调用 NanoClaw，传递上下文
const response = await fetch('http://nanoclaw:8080/api/v1/execute', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': process.env.NANOCLAW_API_KEY
  },
  body: JSON.stringify({
    user_id: userId,
    task_id: taskId,        // 相同的 task_id
    skills: selectedSkills,
    prompt: userInput,
    context: {
      messages: history      // 传递完整对话历史
    },
    stream: true
  })
});

// 4. 处理 SSE 流...
// 5. 保存新对话到数据库...
```

### 场景3：长对话的上下文管理

```typescript
// 当对话很长时，可以选择只传递最近 N 条
const allHistory = await db.getConversationHistory(userId, taskId);
const recentHistory = allHistory.slice(-10);  // 只取最近10条

// 可选：生成摘要
const summary = await generateSummary(allHistory.slice(0, -10));

const response = await fetch('http://nanoclaw:8080/api/v1/execute', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': process.env.NANOCLAW_API_KEY
  },
  body: JSON.stringify({
    user_id: userId,
    task_id: taskId,
    skills: selectedSkills,
    prompt: userInput,
    context: {
      messages: recentHistory,  // 最近10条
      summary: summary          // 之前的摘要
    },
    stream: true
  })
});
```

---

## 文件共享

### 上传文件给 Agent

1. **用户上传文件到你的网站**
2. **保存到共享目录**: `/shared/uploads/{user_id}/{filename}`
3. **调用 API 时传递路径**:

```typescript
const response = await fetch('http://nanoclaw:8080/api/v1/execute', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': process.env.NANOCLAW_API_KEY
  },
  body: JSON.stringify({
    user_id: userId,
    task_id: taskId,
    skills: ['file', 'data_analysis'],
    prompt: '分析这个CSV文件',
    files: ['/shared/uploads/alice/sales_data.csv'],
    stream: true
  })
});
```

### 获取 Agent 生成的文件

Agent 生成的文件会放在 `/shared/outputs/{user_id}/{task_id}/`，通过 SSE `file` 事件返回：

```typescript
// SSE 事件示例
{"type": "file", "path": "/shared/outputs/alice/task_001/report.html", "name": "report.html"}
```

**docker-compose.yml 配置**:

```yaml
version: '3'
services:
  website:
    build: ./website
    volumes:
      - shared-data:/shared
    environment:
      - NANOCLAW_API_KEY=xxx
      - NANOCLAW_BASE_URL=http://nanoclaw:8080

  nanoclaw:
    build: ./nanoclaw
    volumes:
      - shared-data:/shared
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - WEB_API_KEY=xxx
      - WEB_PORT=8080
      - SHARED_UPLOADS_DIR=/shared/uploads
      - SHARED_OUTPUTS_DIR=/shared/outputs

volumes:
  shared-data:
```

---

## 错误处理

**HTTP 错误码**:

| 状态码 | 说明 |
|--------|------|
| 400 | 请求参数错误（缺少必填字段、JSON格式错误） |
| 401 | 认证失败（缺少或无效的 X-API-Key） |
| 404 | 接口不存在 |
| 500 | 服务器内部错误 |

**SSE 错误事件**:
```json
{"type": "error", "message": "容器启动失败", "code": "EXECUTION_ERROR"}
```

常见错误码：
- `EXECUTION_ERROR`: 任务执行失败
- `INTERNAL_ERROR`: 内部服务器错误

---

## 数据库设计建议

在你的网站中，建议存储以下数据：

```sql
-- 任务表
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT,                    -- 任务名称（用户可自定义）
  skills JSONB,                 -- 使用的技能列表
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);

-- 消息表
CREATE TABLE messages (
  id SERIAL PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  role TEXT CHECK (role IN ('user', 'assistant')),
  content TEXT,
  created_at TIMESTAMP
);
```

---

## 关键提醒

1. **NanoClaw 是无状态的**：对话历史必须由你的网站存储和管理
2. **每次调用传递完整上下文**：通过 `context.messages` 传递历史对话
3. **任务目录是临时的**：执行完成后自动清理，不要把持久化数据存在任务目录
4. **用户完全隔离**：不同 `user_id` 的数据互不可见
5. **上下文长度限制**：如果历史消息太多，建议只传递最近 N 条或使用 `summary`
