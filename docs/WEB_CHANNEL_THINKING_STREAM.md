# Web Channel 思考过程流式显示方案

## 需求
在 Web Channel 中实时显示 agent 的处理过程（思考内容），不显示工具调用。

## 方案概述
通过扩展容器输出协议，在 agent-runner 中捕获 assistant 的流式输出，通过新的 progress marker 传递给前端。

## 修改文件

### 1. container/agent-runner/src/index.ts

**新增进度输出函数：**
```typescript
function writeProgress(type: string, content: string): void {
  console.log('---NANOCLAW_PROGRESS_START---');
  console.log(JSON.stringify({ type, content, timestamp: Date.now() }));
  console.log('---NANOCLAW_PROGRESS_END---');
}
```

**在 runQuery 的 for await 循环中，增加：**
```typescript
for await (const message of query({...})) {
  // ... 原有代码 ...

  // 输出思考过程（assistant 的流式内容）
  if (message.type === 'assistant') {
    const textContent = message.content
      ?.filter((c: { type: string; text?: string }) => c.type === 'text')
      .map((c: { text: string }) => c.text)
      .join('');

    if (textContent) {
      writeProgress('thinking', textContent);  // 发送思考片段
    }
  }

  // 最终结果（已有）
  if (message.type === 'result') {
    writeOutput({...});
  }
}
```

### 2. src/container-runner.ts

**添加新的 marker 常量：**
```typescript
const PROGRESS_START_MARKER = '---NANOCLAW_PROGRESS_START---';
const PROGRESS_END_MARKER = '---NANOCLAW_PROGRESS_END---';
```

**在 container.stdout.on('data') 中，增加解析：**
```typescript
container.stdout.on('data', (data) => {
  parseBuffer += chunk;

  // 解析进度事件
  let pStart: number;
  while ((pStart = parseBuffer.indexOf(PROGRESS_START_MARKER)) !== -1) {
    const pEnd = parseBuffer.indexOf(PROGRESS_END_MARKER, pStart);
    if (pEnd === -1) break;

    const jsonStr = parseBuffer
      .slice(pStart + PROGRESS_START_MARKER.length, pEnd)
      .trim();
    parseBuffer = parseBuffer.slice(0, pStart) +
                  parseBuffer.slice(pEnd + PROGRESS_END_MARKER.length);

    try {
      const progress = JSON.parse(jsonStr);
      // 传递进度事件
      outputChain = outputChain.then(() =>
        onOutput?.({
          status: 'progress',
          result: null,
          progress
        })
      );
    } catch (err) {
      // 忽略解析错误
    }
  }

  // ... 原有的 OUTPUT_START/END 解析 ...
});
```

### 3. src/channels/web/task-executor.ts

**在 onOutput 回调中处理进度：**
```typescript
async (output) => {
  // 处理思考过程
  if (output.status === 'progress' && output.progress?.type === 'thinking') {
    onEvent({
      type: 'thinking',
      content: output.progress.content,
    });
    return;
  }

  // 原有处理
  if (output.result) {
    onEvent({ type: 'content', content: output.result });
  }
  if (output.error) {
    onEvent({ type: 'error', message: output.error });
  }
}
```

## SSE 事件类型

```typescript
export type SSEEvent =
  | { type: 'start'; user_id: string; task_id: string; timestamp: string }
  | { type: 'thinking'; content: string }        // ← 思考过程（新增）
  | { type: 'content'; content: string }         // ← 最终结果
  | { type: 'error'; message: string; code?: string }
  | { type: 'complete'; task_id: string; usage: { duration_ms: number } };
```

## 前端使用示例

```javascript
const eventSource = new EventSource('/api/tasks/stream');

// 接收思考过程（流式）
eventSource.addEventListener('thinking', (e) => {
  const data = JSON.parse(e.data);
  appendThinking(data.content);  // 追加到思考区域
});

// 接收最终结果
eventSource.addEventListener('content', (e) => {
  const data = JSON.parse(e.data);
  displayResult(data.content);   // 显示结果
});

// 任务完成
eventSource.addEventListener('complete', (e) => {
  const data = JSON.parse(e.data);
  console.log('耗时:', data.usage.duration_ms);
  eventSource.close();
});
```

## 注意事项

1. **镜像重建**：修改 `container/agent-runner/src/index.ts` 后需要重新构建 Docker 镜像
2. **思考内容累积**：前端可以选择累积显示所有 thinking 片段，或只显示最新片段
3. **不显示工具调用**：此方案只捕获 `assistant` 类型的消息，不捕获 `tool_use`/`tool_result`

## 重建命令

```bash
cd /drives/d/python_project/nanoclaw/container
./build.sh
```

或手动执行：

```bash
docker build -t nanoclaw-agent:latest .
```
