# NanoClaw Web Channel SaaS 设计文档（调整后）

## Context

将 NanoClaw 扩展支持 Web Channel 技能，用户通过 Web 界面与 AI Agent 对话。Web Channel 作为独立技能添加，SaaS 平台功能与 NanoClaw 核心分离。

---

## 1. 架构设计（调整后）

### 1.1 关注点分离

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           NanoClaw Core                                  │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                     Orchestrator (index.ts)                      │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │   │
│  │  │   WhatsApp  │  │  Telegram   │  │      Web Channel        │  │   │
│  │  │   Channel   │  │   Channel   │  │     (skill)             │  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────────────────┘  │   │
│  │                                                                │   │
│  │  所有 Channel 通过 registry.ts 自注册，统一接口                   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  groups/                    data/                                        │
│  ├── {group_folder}/        ├── nanoclaw.db                              │
│  │   ├── CLAUDE.md           └── ipc/{group_folder}/                      │
│  │   └── logs/                                                            │
│  └── ...                                                                 │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTP/WebSocket
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     src/infocloud/ (SaaS 平台层)                         │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    Web 前端应用 (React)                          │   │
│  │  ┌─────────────────────────────────────────────────────────┐   │   │
│  │  │  对话页面                                                │   │   │
│  │  │  ┌─────────────┐  ┌─────────────────────────────────┐   │   │   │
│  │  │  │  Chat UI    │  │      Web Channel Component      │   │   │   │
│  │  │  │  (业务界面)  │──▶│      (聊天对话框组件)            │   │   │   │
│  │  │  │             │  │      - WebSocket 连接            │   │   │   │
│  │  │  │             │  │      - 消息输入/展示              │   │   │   │
│  │  │  │             │  │      - 连接状态管理               │   │   │   │
│  │  │  └─────────────┘  └─────────────────────────────────┘   │   │   │
│  │  │                                                           │   │   │
│  │  │  其它页面 (可选): 设置、历史记录、知识库等                   │   │   │
│  │  └─────────────────────────────────────────────────────────┘   │   │
│  │                                                                 │   │
│  │  src/infocloud/server/                                          │   │
│  │  ├── api/                 # REST API (可选，如需要)               │   │
│  │  ├── auth/                # 简单的认证中间件 (固定用户)            │   │
│  │  └── index.ts             # Web 前端 server 入口                │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  **设计原则**: 这一层完全独立，不修改 NanoClaw 核心代码                    │
│              通过 HTTP/WebSocket 与 Web Channel 通信                    │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Web Channel 定位

Web Channel 是一个**纯粹的 Channel 技能实现**，职责单一：

| 职责 | 说明 |
|------|------|
| 启动 HTTP Server | 监听指定端口，提供 WebSocket 和 REST API |
| 管理 WebSocket 连接 | 维护客户端连接，处理连接生命周期 |
| 实现 Channel 接口 | `sendMessage`, `ownsJid`, `connect` 等 |
| 消息转发 | 将 Web 端消息送入 orchestrator，将回复推送给客户端 |

**不涉及的功能**（移到 src/infocloud/ 或不做）：
- ❌ 用户注册/登录系统
- ❌ 收费/套餐管理
- ❌ 多租户管理
- ❌ SaaS 业务逻辑

---

## 2. Web Channel 技能实现

参考 `add-discord` 技能的实现方式：单一文件 + 自注册模式。

### 2.1 文件结构

```
src/channels/web.ts       # Web Channel 单一文件实现（参考 discord.ts）
src/channels/web.test.ts  # 单元测试（参考 discord.test.ts）
src/channels/index.ts     # 添加 import './web.js'
```

### 2.2 核心实现

**文件**: `src/channels/web.ts`

```typescript
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, IncomingMessage } from 'http';
import { parse } from 'url';
import type { Channel, ChannelOpts } from '../types.js';
import { registerChannel } from './registry.js';
import { logger } from '../logger.js';

// Web Channel 配置（从环境变量读取）
const WEB_ENABLED = process.env.WEB_ENABLED === 'true';
const WEB_PORT = parseInt(process.env.WEB_PORT || '3000', 10);
const WEB_TOKEN = process.env.WEB_TOKEN || ''; // 固定 token 认证

// JID 和 Group 配置（固定用户模式）
const FIXED_JID = 'web:fixed_user';
const FIXED_GROUP_FOLDER = 'web_user';

interface WebConnection {
  ws: WebSocket;
  jid: string;
  connectedAt: Date;
}

class WebChannel implements Channel {
  name = 'web';
  private wss: WebSocketServer | null = null;
  private connections = new Map<string, WebConnection>();
  private opts: ChannelOpts | null = null;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (!WEB_ENABLED) {
      logger.info('[WebChannel] Disabled (WEB_ENABLED !== true)');
      return;
    }

    if (!WEB_TOKEN) {
      logger.warn('[WebChannel] WEB_TOKEN not set, channel disabled');
      return;
    }

    // 创建 HTTP server 和 WebSocket server
    const server = createServer();
    this.wss = new WebSocketServer({ server });

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    return new Promise((resolve, reject) => {
      server.listen(WEB_PORT, () => {
        logger.info(`[WebChannel] Server started on port ${WEB_PORT}`);
        resolve();
      });
      server.on('error', reject);
    });
  }

  async disconnect(): Promise<void> {
    this.wss?.close();
    this.connections.clear();
  }

  isConnected(): boolean {
    return this.wss !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('web:');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const conn = this.connections.get(jid);
    if (!conn) {
      logger.warn(`[WebChannel] No active connection for ${jid}`);
      return;
    }

    conn.ws.send(JSON.stringify({
      type: 'message',
      content: text,
      timestamp: new Date().toISOString(),
    }));
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const conn = this.connections.get(jid);
    if (!conn) return;

    conn.ws.send(JSON.stringify({
      type: 'typing',
      isTyping,
    }));
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    // 从 URL query 解析 token
    const { query } = parse(req.url || '', true);
    const token = query.token as string;

    // 简单 token 认证
    if (token !== WEB_TOKEN) {
      ws.close(1008, 'Invalid token');
      return;
    }

    // 保存连接（固定 JID）
    this.connections.set(FIXED_JID, {
      ws,
      jid: FIXED_JID,
      connectedAt: new Date(),
    });

    // 发送连接成功消息
    ws.send(JSON.stringify({
      type: 'connected',
      jid: FIXED_JID,
    }));

    ws.on('message', (data) => {
      this.handleMessage(FIXED_JID, data.toString());
    });

    ws.on('close', () => {
      this.connections.delete(FIXED_JID);
      logger.info(`[WebChannel] Connection closed for ${FIXED_JID}`);
    });

    ws.on('error', (err) => {
      logger.error('[WebChannel] WebSocket error:', err);
    });
  }

  private handleMessage(jid: string, data: string): void {
    try {
      const parsed = JSON.parse(data);
      const text = parsed.content || parsed.text || parsed.message;

      if (!text || typeof text !== 'string') {
        logger.warn('[WebChannel] Invalid message format');
        return;
      }

      // 构造 NewMessage 并送入 orchestrator
      const message = {
        id: `web_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        chat_jid: jid,
        sender: jid,
        sender_name: 'Web User',
        content: text,
        timestamp: new Date().toISOString(),
        is_from_me: false,
      };

      this.opts?.onMessage(jid, message);
    } catch (err) {
      logger.error('[WebChannel] Failed to handle message:', err);
    }
  }
}

// 自注册到 Channel Registry
registerChannel('web', (opts) => {
  if (!WEB_ENABLED) return null;
  return new WebChannel(opts);
});
```

### 2.3 JID 设计

| 格式 | 示例 | 说明 |
|------|------|------|
| `web:{user_id}` | `web:fixed_user` | 固定用户模式 |
| `web:{uuid}` | `web:550e8400...` | 预留：后续多用户支持 |

**初始版本**: 使用固定 JID `web:fixed_user`，group folder 为 `web_user`。

### 2.4 依赖添加

**文件**: `package.json`

```json
{
  "dependencies": {
    "ws": "^8.16.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.10"
  }
}
```

---

## 3. src/infocloud/ SaaS 平台层

### 3.1 目录结构

```
src/infocloud/
├── client/                       # 前端 React 应用
│   ├── src/
│   │   ├── components/
│   │   │   ├── ChatPage/         # 对话主页面
│   │   │   │   ├── index.tsx
│   │   │   │   └── styles.css
│   │   │   └── WebChannelChat/   # Web Channel 聊天组件
│   │   │       ├── index.tsx     # 核心对话框组件
│   │   │       ├── MessageList.tsx
│   │   │       ├── MessageInput.tsx
│   │   │       ├── useWebSocket.ts
│   │   │       └── types.ts
│   │   ├── hooks/
│   │   ├── pages/
│   │   └── App.tsx
│   ├── index.html
│   ├── package.json
│   └── vite.config.ts
├── server/                       # 前端静态文件 server（可选）
│   └── index.ts
└── package.json
```

### 3.2 Web Channel 组件设计

**文件**: `src/infocloud/client/src/components/WebChannelChat/index.tsx`

```typescript
/**
 * WebChannelChat 组件
 *
 * 这是一个纯 UI 组件，负责：
 * - 建立与 Web Channel 的 WebSocket 连接
 * - 渲染消息列表和输入框
 * - 管理本地消息状态
 *
 * 不处理业务逻辑（如用户认证、历史记录存储等），
 * 这些由父组件 ChatPage 处理。
 */

interface WebChannelChatProps {
  webSocketUrl: string;           // ws://localhost:3000/ws
  token: string;                  // 认证 token
  userName?: string;              // 显示的用户名
  onMessageSent?: (msg: Message) => void;
  onMessageReceived?: (msg: Message) => void;
}

export function WebChannelChat({
  webSocketUrl,
  token,
  userName = 'User',
}: WebChannelChatProps) {
  const { messages, sendMessage, isConnected } = useWebSocket(webSocketUrl, token);

  return (
    <div className="web-channel-chat">
      <ConnectionStatus connected={isConnected} />
      <MessageList messages={messages} userName={userName} />
      <MessageInput onSend={sendMessage} disabled={!isConnected} />
    </div>
  );
}
```

### 3.3 使用方式

**文件**: `src/infocloud/client/src/pages/ChatPage.tsx`

```typescript
/**
 * ChatPage - 对话页面
 *
 * 作为 Web Channel 组件的容器，可添加业务逻辑：
 * - 用户信息显示
 * - 历史会话列表
 * - 设置面板
 * - 等等
 */

export function ChatPage() {
  // 固定 token（后续可改为从配置或简单 auth 获取）
  const token = import.meta.env.VITE_WEB_CHANNEL_TOKEN || 'default-token';
  const wsUrl = import.meta.env.VITE_WEB_CHANNEL_URL || 'ws://localhost:3000/ws';

  return (
    <div className="chat-page">
      <Sidebar />
      <main className="chat-container">
        {/* 将 Web Channel 作为组件引入 */}
        <WebChannelChat
          webSocketUrl={wsUrl}
          token={token}
          userName="Fixed User"
        />
      </main>
    </div>
  );
}
```

---

## 4. 数据模型（简化版）

### 4.1 无需新增 users 表

**调整后**: 不实现用户系统，直接使用固定 group。

环境变量配置：
```bash
WEB_ENABLED=true
WEB_PORT=3000
WEB_TOKEN=your-secure-random-token-here
```

### 4.2 Group 自动创建

首次启动时检查并创建固定 group（在 web.ts 的 connect 方法中实现）：

```typescript
// 在 WebChannel.connect() 中调用
private async ensureWebGroup(): Promise<void> {
  const { getRegisteredGroup, setRegisteredGroup } = await import('../db.js');
  const { resolveGroupFolderPath } = await import('../config.js');

  const existing = getRegisteredGroup(FIXED_JID);
  if (existing) return;

  // 创建 group 目录
  const { mkdirSync, existsSync, writeFileSync } = await import('fs');
  const { join } = await import('path');

  const groupDir = resolveGroupFolderPath(FIXED_GROUP_FOLDER);
  mkdirSync(join(groupDir, 'logs'), { recursive: true });

  // 创建默认 CLAUDE.md
  const claudeMdPath = join(groupDir, 'CLAUDE.md');
  if (!existsSync(claudeMdPath)) {
    writeFileSync(claudeMdPath, `# Web User

This is the web channel user group.
`);
  }

  // 注册到数据库
  setRegisteredGroup(FIXED_JID, {
    name: 'Web User',
    folder: FIXED_GROUP_FOLDER,
    trigger: '@Assistant',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    isMain: false,
  });

  logger.info(`[WebChannel] Created web group: ${FIXED_GROUP_FOLDER}`);
}
```

---

## 5. 配置变更

### 5.1 环境变量

**文件**: `.env` 或 `.env.example`

```bash
# Web Channel
WEB_ENABLED=true
WEB_PORT=3000
WEB_TOKEN=your-secure-random-token-here
```

### 5.2 无需修改 config.ts

Web Channel 配置直接从环境变量读取（参考 discord.ts 模式），不添加到 `src/config.ts`。这样保持核心代码干净，Channel 技能自包含配置。

---

## 6. 部署架构（简化版）

### 6.1 开发环境

```
终端 1: npm run dev              # NanoClaw core + Web Channel
终端 2: cd src/infocloud/client && npm run dev   # 前端开发服务器
```

### 6.2 生产环境

```
Cloud VPS
├── NanoClaw Core (Node.js)
│   ├── WebSocket: 3000
│   └── groups/web_user/
│
├── Nginx (443)
│   ├── /api/ws → proxy_pass ws://localhost:3000
│   └── / → static files (src/infocloud/client/dist)
│
└── src/infocloud/client/dist    # 构建后的前端
```

---

## 7. 文件清单

### 7.1 新增文件（Web Channel 技能 - 参考 add-discord）

```
src/channels/web.ts       # Web Channel 单一文件实现（同 discord.ts）
src/channels/web.test.ts  # 单元测试（同 discord.test.ts）
```

### 7.2 新增文件（SaaS 平台层 - src/infocloud/）

```
src/infocloud/
├── client/               # React 前端
│   ├── src/
│   │   ├── components/
│   │   │   └── WebChannelChat/    # 核心聊天组件
│   │   └── pages/
│   │       └── ChatPage.tsx       # 对话页面
│   ├── package.json
│   └── vite.config.ts
└── server/               # 可选的静态文件 server
```

### 7.3 修改文件

```
src/channels/index.ts     # 添加: import './web.js'
package.json              # 添加: "ws" 和 "@types/ws" 依赖
.env.example              # 添加: WEB_ENABLED, WEB_PORT, WEB_TOKEN
```

### 7.4 与 add-discord 的对比

| 项目 | add-discord | add-web |
|------|-------------|---------|
| Channel 文件 | `src/channels/discord.ts` | `src/channels/web.ts` |
| 测试文件 | `src/channels/discord.test.ts` | `src/channels/web.test.ts` |
| 依赖 | `discord.js` | `ws` |
| Barrel 导入 | `import './discord.js'` | `import './web.js'` |
| 环境变量 | `DISCORD_BOT_TOKEN` | `WEB_ENABLED`, `WEB_PORT`, `WEB_TOKEN` |

---

## 8. 与原始设计的差异对比

| 方面 | 原始设计 | 调整后设计 |
|------|---------|-----------|
| **Web Channel** | 包含完整用户认证、注册、SaaS 功能 | 纯 Channel 技能，只负责消息收发 |
| **用户系统** | 完整 users 表，注册登录流程 | 固定用户，无注册模块 |
| **前端位置** | `web/frontend/` 与核心混合 | `src/infocloud/client/` 完全分离 |
| **代码融合** | 修改 db.ts、添加认证 API 等 | 不修改现有代码，仅添加 Channel 技能 |
| **收费系统** | 完整套餐、计费、Stripe 集成 | 不做 |
| **多租户** | 自动开通 group，多用户 | 固定单一 group |
| **部署复杂度** | Docker Compose + Nginx + SSL | 可选简单部署，前端可独立 |

---

## 9. 开发步骤（参考 add-discord）

### Phase 1: Web Channel 技能（同 discord skill 模式）
1. 安装依赖: `npm install ws && npm install -D @types/ws`
2. 创建 `src/channels/web.ts`（单一文件，参考 `discord.ts` 结构）
3. 创建 `src/channels/web.test.ts` 单元测试
4. 在 `src/channels/index.ts` 添加 `import './web.js'`
5. 在 `.env.example` 添加 `WEB_ENABLED`, `WEB_PORT`, `WEB_TOKEN`
6. 测试 WebSocket 连接和消息收发

### Phase 2: 前端组件（src/infocloud/）
1. 创建 `src/infocloud/client/` React 项目
2. 实现 `WebChannelChat` 组件
3. 实现 `ChatPage` 页面
4. 配置开发代理，连接 Web Channel

### Phase 3: 整合测试
1. 端到端测试：前端 → Web Channel → Orchestrator → Container → 回复
2. 验证固定 group 正确创建
3. 部署到测试环境

---

## Summary

**核心调整**: 将 Web Channel 从"完整 SaaS 平台"降级为"纯 Channel 技能"，业务功能移到独立的 `src/infocloud/` 目录。

**优势**:
- 符合 NanoClaw "技能化"架构设计
- 不污染现有代码，易于维护
- 开发迭代快（固定用户，无需注册流程）
- 前端与 Channel 解耦，可独立开发

**预估工作量**: **3-5 天**（单人）
- Web Channel 技能: 1-2 天
- 前端组件: 1-2 天
- 整合测试: 0.5-1 天
