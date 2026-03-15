# NanoClaw Web Channel 设计方案

## 架构定位

**网站**作为核心平台，负责：
- 用户认证和管理
- 技能市场展示和用户选择
- 历史任务记录管理
- 任务调度和管理

**NanoClaw**作为 Agent 执行引擎，负责：
- 接收任务请求（HTTP）
- 在容器中运行 Agent
- 流式返回执行结果（SSE）
- 管理任务上下文（用户隔离、任务隔离、上下文恢复）

**通信协议**: HTTP + Server-Sent Events (SSE)

## 核心概念

NanoClaw 中只有两层结构：

```
groups/
└── users/
    └── {user_id}/                    # 用户目录
        └── tasks/
            └── {task_id}/            # 任务目录（运行时）
                ├── CLAUDE.md         # 系统提示（动态生成）
                ├── skills/           # 该任务安装的技能
                └── uploads/          # 本次调用上传的文件
```

| 概念 | 说明 | 生命周期 |
|------|------|----------|
| **User** | 网站用户，通过 `user_id` 标识 | 长期（目录隔离） |
| **Task** | 单次执行的任务，通过 `task_id` 标识 | 短期（执行期间存在） |
| **Context** | 对话历史，由**网站存储和管理** | 网站负责 |

**关键设计**:
- **NanoClaw 是无状态的**：不存储对话历史，只负责单次执行
- **网站负责上下文管理**：网站在每次调用时通过 `context` 参数传递完整历史
- 任务目录 `groups/users/{user_id}/tasks/{task_id}/` 只在执行期间存在，执行后清理
- 用户隔离通过 `user_id` 目录实现，任务隔离通过单次执行实现

## 核心问题解答

### 1. API Key 管理

**方案**: 使用单一共享密钥（Shared Secret）

```bash
# .env (NanoClaw 配置)
WEB_API_KEY=nanoclaw_internal_key_xxx

# 网站后端配置
NANOCLAW_API_KEY=nanoclaw_internal_key_xxx
NANOCLAW_BASE_URL=http://localhost:8080
```

### 2. 技能如何在 Agent 中生效

**方案**: 动态技能注入

- 新建任务（`is_new_task: true`）：复制技能模板到 `tasks/{task_id}/skills/`
- 继续任务（`is_new_task: false`）：使用已有的技能（或可选择更新技能列表）
- Agent 通过 `tasks/{task_id}/skills/*.md` 获得能力

### 3. 文件如何传递给 Agent

**方案**: 共享卷挂载

```
1. 用户上传文件到网站
2. 网站存储到 /shared/uploads/{user_id}/{filename}
3. 网站调用 API 时传递文件路径
4. NanoClaw 在任务文件夹创建软链接
5. Agent 通过 /workspace/group/uploads/ 访问
```

### 4. 用户隔离与任务隔离

```
A用户（user_id: "alice"）
├── tasks/geo_001/          ← GEO优化任务
├── tasks/ppt_001/          ← PPT制作任务
└── tasks/data_001/         ← 数据分析任务

B用户（user_id: "bob"）
└── tasks/report_001/       ← 完全隔离，无法访问 alice 的数据
```

### 5. 上下文管理设计（网站负责存储）

**核心原则：NanoClaw 是无状态的，网站负责管理对话上下文**

```
┌─────────────────────────────────────────────────────────────────┐
│                         网站 (Website)                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │   用户认证    │  │   任务管理    │  │   对话历史存储        │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│                                    │                           │
│                              数据库存储                          │
│                        (对话历史、上下文)                        │
└────────────────────────────────────┼───────────────────────────┘
                                     │ HTTP POST + context 参数
                                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                  NanoClaw (无状态执行引擎)                        │
│                                                                 │
│  1. 接收请求（包含完整的 context.messages）                      │
│  2. 创建临时执行目录                                            │
│  3. 将 context.messages 格式化为 Agent prompt                   │
│  4. 执行 Agent                                                  │
│  5. 返回结果（SSE 流）                                          │
│  6. 清理临时目录                                                │
│                                                                 │
│  ❌ 不存储任何对话历史                                           │
│  ❌ 不管理会话状态                                               │
│  ✅ 只负责单次执行                                               │
└─────────────────────────────────────────────────────────────────┘
```

**上下文传递流程**:

```typescript
// 1. 网站从数据库读取对话历史
const history = await db.getConversationHistory(userId, taskId);
// 返回: [{role: 'user', content: '...'}, {role: 'assistant', content: '...'}]

// 2. 网站调用 NanoClaw，传递完整上下文
await fetch('http://nanoclaw:8080/api/v1/execute', {
  method: 'POST',
  body: JSON.stringify({
    user_id: userId,
    task_id: taskId,
    skills: ['geo'],
    prompt: '继续优化...',
    context: {
      messages: history  // 完整对话历史
    }
  })
});

// 3. NanoClaw 构造 prompt（包含上下文）
const prompt = `
${context.messages.map(m => `<${m.role}>${m.content}</${m.role}>`).join('\n')}
<user>${currentPrompt}</user>
`;

// 4. Agent 执行，看到完整对话历史

// 5. 网站保存新的对话到数据库
await db.saveMessage(userId, taskId, {role: 'user', content: currentPrompt});
await db.saveMessage(userId, taskId, {role: 'assistant', content: result});
```

**为什么采用这种设计？**

1. **NanoClaw 职责单一**：只做 Agent 执行，不做状态管理
2. **网站掌控数据**：对话历史存在网站数据库，便于分析、搜索、备份
3. **灵活性高**：网站可以自定义上下文策略（如只传最近 N 条、摘要等）
4. **无状态易扩展**：NanoClaw 可以水平扩展，不需要共享存储

**注意事项**:

- 如果 `context.messages` 很长，Agent 的 prompt 会很大，可能超出 token 限制
- 网站需要自行实现上下文截断策略（如只保留最近 20 条）
- 对于超长对话，建议使用 `context.summary` 传递摘要

## API 设计

### 核心端点: 执行任务 (HTTP + SSE)

```http
POST /api/v1/execute
Content-Type: application/json
X-API-Key: {shared_secret}
```

**请求体**:
```json
{
  "user_id": "alice",
  "task_id": "geo_optimization",
  "skills": ["geo", "browser"],
  "prompt": "继续优化网站SEO",
  "context": {
    "messages": [
      {"role": "user", "content": "帮我优化SEO..."},
      {"role": "assistant", "content": "好的，我分析了您的网站..."},
      {"role": "user", "content": "已修改标题，下一步做什么？"}
    ],
    "summary": "用户网站example.com已优化标题和描述，当前在做内链优化"
  },
  "files": [
    "/shared/uploads/alice/website_data.csv"
  ],
  "stream": true,
  "timeout": 300000
}
```

**参数说明**:

| 参数 | 必填 | 说明 |
|------|------|------|
| `user_id` | 是 | 用户标识，用于数据隔离和目录创建 |
| `task_id` | 是 | 任务标识，用于创建临时执行目录。每次调用可以是新的 task_id 或相同的 task_id |
| `skills` | 是 | 本次任务需要的技能列表，动态安装到执行环境 |
| `prompt` | 是 | 用户当前的输入提示 |
| `context` | 否 | 对话上下文（历史消息），由网站存储和管理 |
| `context.messages` | 否 | 历史对话消息数组，按顺序传递给 Agent |
| `context.summary` | 否 | 可选的上下文摘要，用于长对话的场景 |
| `files` | 否 | 上传的文件路径列表 |
| `stream` | 否 | 是否启用 SSE 流式输出，默认 `true` |
| `timeout` | 否 | 任务超时时间（毫秒），默认 300000 (5分钟) |

**上下文传递说明**:

- **NanoClaw 是无状态的**：不存储任何对话历史
- **网站负责管理上下文**：网站在自己的数据库中存储对话历史
- **每次调用传递完整上下文**：网站在调用时将历史消息通过 `context.messages` 传递给 NanoClaw
- **Agent 看到完整对话**：NanoClaw 将 `context.messages` 格式化为 prompt 的一部分，Agent 可以 "看到" 之前的对话

**响应头 (SSE)**:
```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

**SSE 事件流**:

```
data: {"type": "start", "user_id": "alice", "task_id": "geo_optimization", "timestamp": "2026-03-12T10:30:00Z"}

data: {"type": "thinking", "content": "我需要先读取CSV文件..."}

data: {"type": "thinking", "content": "文件包含1000条记录..."}

data: {"type": "content", "content": "根据数据分析，建议..."}

data: {"type": "tool_start", "tool": "browser", "input": {"url": "https://example.com"}}

data: {"type": "tool_complete", "tool": "browser"}

data: {"type": "file", "path": "/shared/outputs/alice/geo_optimization/report.html", "name": "report.html"}

data: {"type": "complete", "task_id": "geo_optimization", "usage": {"duration_ms": 25000, "tokens_input": 2000, "tokens_output": 800}}
```

### SSE 事件类型

| 类型 | 描述 |
|------|------|
| `start` | 任务开始 |
| `thinking` | Agent 思考过程 |
| `content` | Agent 回复内容 |
| `tool_start` | 开始执行工具 |
| `tool_complete` | 工具执行完成 |
| `file` | 生成的文件 |
| `error` | 执行错误 |
| `complete` | 任务完成 |

### 其他端点

**查询任务状态**:
```http
GET /api/v1/users/{user_id}/tasks/{task_id}
X-API-Key: {shared_secret}
```

**删除任务（清空上下文）**:
```http
DELETE /api/v1/users/{user_id}/tasks/{task_id}
X-API-Key: {shared_secret}
```

**获取可用技能列表**:
```http
GET /api/v1/skills
X-API-Key: {shared_secret}
```

## 使用示例

### 场景1：A用户新建GEO优化任务（第一次对话）

```typescript
// 网站创建新任务，生成 task_id
const taskId = 'geo_2024_03_12';

// 第一次调用，没有历史上下文
const response = await fetch('http://localhost:8080/api/v1/execute', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': 'nanoclaw_internal_key_xxx'
  },
  body: JSON.stringify({
    user_id: 'alice',
    task_id: taskId,
    skills: ['geo', 'browser'],
    prompt: '帮我优化这个网站的SEO',
    // 第一次调用，context 为空或省略
    stream: true
  })
});

// 网站保存对话到数据库
await db.saveMessage('alice', taskId, {role: 'user', content: '帮我优化这个网站的SEO'});
await db.saveMessage('alice', taskId, {role: 'assistant', content: 'Agent的回复...'});
```

### 场景2：第二天继续同一任务

```typescript
// 用户点击网站上的历史任务 "geo_2024_03_12"
// 网站从数据库读取对话历史
const history = await db.getConversationHistory('alice', 'geo_2024_03_12');
// 返回: [
//   {role: 'user', content: '帮我优化这个网站的SEO'},
//   {role: 'assistant', content: '好的，我分析了您的网站...'}
// ]

const response = await fetch('http://localhost:8080/api/v1/execute', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': 'nanoclaw_internal_key_xxx'
  },
  body: JSON.stringify({
    user_id: 'alice',
    task_id: 'geo_2024_03_12',
    skills: ['geo', 'browser'],
    prompt: '再帮我检查一下关键词密度',
    context: {
      messages: history  // 传递完整对话历史
    },
    stream: true
  })
});
// NanoClaw 将 history 格式化为 prompt，Agent 可以看到之前的对话

// 网站保存新的对话
await db.saveMessage('alice', 'geo_2024_03_12', {role: 'user', content: '再帮我检查一下关键词密度'});
await db.saveMessage('alice', 'geo_2024_03_12', {role: 'assistant', content: 'Agent的新回复...'});
```

### 场景3：同时做多个任务（完全隔离）

```typescript
// 任务1：GEO优化（有自己的上下文）
const history1 = await db.getConversationHistory('alice', 'geo_2024_03_12');
fetch('/api/v1/execute', {
  body: JSON.stringify({
    user_id: 'alice',
    task_id: 'geo_2024_03_12',
    skills: ['geo'],
    prompt: '优化SEO...',
    context: { messages: history1 }
  })
});

// 任务2：PPT制作（有自己的上下文，完全隔离）
const history2 = await db.getConversationHistory('alice', 'ppt_2024_03_12');
fetch('/api/v1/execute', {
  body: JSON.stringify({
    user_id: 'alice',
    task_id: 'ppt_2024_03_12',
    skills: ['ppt'],
    prompt: '做一个产品介绍PPT',
    context: { messages: history2 }
  })
});
// 两个任务的 context 完全隔离，互不影响

### 场景4：B用户做任务（完全隔离）

```typescript
// B用户完全隔离，使用不同的 user_id
const response = await fetch('http://localhost:8080/api/v1/execute', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': 'nanoclaw_internal_key_xxx'
  },
  body: JSON.stringify({
    user_id: 'bob',               // 不同的 user_id
    task_id: 'report_2024',
    skills: ['data_analysis'],
    prompt: '分析销售数据',
    // 第一次调用，无需 context
    stream: true
  })
});
// NanoClaw 创建临时目录 groups/users/bob/tasks/report_2024/
// 执行完成后清理，与 alice 完全隔离
```

### 场景5：网站自定义上下文策略（只传最近N条）

```typescript
// 对话很长，网站决定只传递最近 10 条
const allHistory = await db.getConversationHistory('alice', 'geo_2024_03_12');
// 假设有 50 条历史

const recentHistory = allHistory.slice(-10);  // 只取最近 10 条

const response = await fetch('http://localhost:8080/api/v1/execute', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': 'nanoclaw_internal_key_xxx'
  },
  body: JSON.stringify({
    user_id: 'alice',
    task_id: 'geo_2024_03_12',
    skills: ['geo'],
    prompt: '继续优化...',
    context: {
      messages: recentHistory,  // 只传递最近 10 条
      summary: '用户网站example.com，之前已完成关键词分析和标题优化'  // 可选摘要
    },
    stream: true
  })
});
// 网站可以灵活控制传递多少上下文
```

## 文件共享方案

```yaml
# docker-compose.yml
version: '3'
services:
  website:
    build: ./website
    volumes:
      - shared-data:/shared

  nanoclaw:
    build: ./nanoclaw
    volumes:
      - shared-data:/shared
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - WEB_API_KEY=xxx
```

**文件路径约定**:
- 上传文件: `/shared/uploads/{user_id}/{filename}`
- 输出文件: `/shared/outputs/{user_id}/{task_id}/{filename}`
- 运行时任务目录: `/app/groups/users/{user_id}/tasks/{task_id}/`（执行期间存在，执行后清理）

**注意**：NanoClaw 是无状态的，不存储任何对话历史。对话上下文由网站通过 `context` 参数传递。

## context 参数结构

网站调用 NanoClaw 时，通过 `context` 参数传递对话历史：

```json
{
  "context": {
    "messages": [
      {"role": "user", "content": "帮我优化SEO..."},
      {"role": "assistant", "content": "好的，我分析了您的网站..."},
      {"role": "user", "content": "已修改标题，下一步做什么？"}
    ],
    "summary": "用户网站example.com，已优化标题和描述"  // 可选
  }
}
```

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `context` | object | 否 | 对话上下文 |
| `context.messages` | array | 否 | 历史消息数组，按顺序传递给 Agent |
| `context.summary` | string | 否 | 可选的上下文摘要，用于长对话场景 |

### 消息对象结构

```typescript
{
  "role": "user" | "assistant",    // 消息角色
  "content": string                 // 消息内容（完整文本）
}
```

### 上下文管理建议

**网站端策略**（由网站实现）：

1. **完整历史模式**（推荐，适用于大多数任务）：
   ```typescript
   const history = await db.getAllMessages(userId, taskId);
   context: { messages: history }
   ```

2. **最近N条模式**（适用于长对话）：
   ```typescript
   const history = await db.getRecentMessages(userId, taskId, 20);
   context: { messages: history }
   ```

3. **摘要+最近模式**（适用于超长对话）：
   ```typescript
   const summary = await generateSummary(userId, taskId);
   const recent = await db.getRecentMessages(userId, taskId, 10);
   context: {
     messages: recent,
     summary: summary
   }
   ```

**注意事项**：
- 如果 `context.messages` 太长，Agent 的 prompt 会很大，可能超出 token 限制
- 网站需要自行实现上下文截断策略
- NanoClaw 只是接收 `context`，不做任何存储或管理

## 需要修改的文件

| 文件 | 修改内容 |
|------|----------|
| `src/web-api/server.ts` | 新增 HTTP 服务器（支持 SSE） |
| `src/web-api/routes.ts` | 新增 `/execute`, `/skills` 端点 |
| `src/web-api/auth.ts` | 简化 API Key 认证（单一共享密钥） |
| `src/task-manager.ts` | 新增：任务管理（创建、读取、更新、删除） |
| `src/config.ts` | 添加 `WEB_API_KEY`, `SHARED_UPLOADS_DIR` 等配置 |
| `skill-templates/` | 新增目录：存放技能模板文件 |
| `src/container-runner.ts` | 修改：支持输出流捕获和转发 |

## 关键设计决策

1. **NanoClaw 无状态**: NanoClaw 只负责单次 Agent 执行，不存储任何对话历史
2. **网站管理上下文**: 对话历史由网站存储和管理，通过 `context` 参数传递
3. **用户隔离**: 不同 `user_id` 的数据存储在不同目录
4. **任务临时性**: 任务目录只在执行期间存在，执行后清理
5. **灵活性**: 网站可以自定义上下文策略（完整历史、最近N条、摘要等）

## 实施计划

### Phase 1: Web API + SSE 基础
1. 创建 `src/web-api/server.ts` - HTTP 服务器（支持 SSE）
2. 创建 `src/web-api/routes.ts` - `/execute` 端点（接收 context 参数）
3. 创建 `src/web-api/auth.ts` - API Key 认证
4. 修改 `src/config.ts` - 添加配置项

### Phase 2: 任务执行系统
1. 创建 `src/task-executor.ts` - 临时任务目录创建和执行管理
2. 实现 `context` 参数解析和 prompt 构造
3. 集成容器运行和 SSE 输出流

### Phase 3: 技能模板系统
1. 创建 `skill-templates/` 目录
2. 实现技能模板复制到临时任务目录

### Phase 4: 文件共享集成
1. 配置文件共享卷
2. 实现上传文件软链接创建
3. 实现输出文件收集和返回

### Phase 5: 测试与验证
1. 单元测试
2. 集成测试（验证 context 传递和恢复）
3. 端到端测试
