/**
 * Web Channel HTTP Server
 * Handles HTTP requests and SSE streaming
 */
import http from 'http';
import { URL } from 'url';

import { WEB_HOST, WEB_PORT } from '../../config.js';
import { logger } from '../../logger.js';
import { validateApiKey } from './auth.js';
import { executeTask, getAvailableSkills, SSEEvent } from './task-executor.js';

interface ExecuteRequestBody {
  user_id: string;
  task_id: string;
  skills?: string[];
  prompt: string;
  context?: {
    messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
    summary?: string;
  };
  files?: string[];
  stream?: boolean;
  timeout?: number;
}

/**
 * Parse JSON body from request
 */
function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send SSE event
 */
function sendSSE(
  res: http.ServerResponse,
  event: SSEEvent
): void {
  const data = JSON.stringify(event);
  res.write(`data: ${data}\n\n`);
}

/**
 * Send error response
 */
function sendError(
  res: http.ServerResponse,
  statusCode: number,
  message: string,
  code?: string
): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message, code }));
}

/**
 * Handle execute request
 */
async function handleExecute(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  // Parse request body
  let body: ExecuteRequestBody;
  try {
    body = (await parseBody(req)) as ExecuteRequestBody;
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return;
  }

  // Validate required fields
  if (!body.user_id) {
    sendError(res, 400, 'Missing required field: user_id');
    return;
  }
  if (!body.task_id) {
    sendError(res, 400, 'Missing required field: task_id');
    return;
  }
  if (!body.prompt) {
    sendError(res, 400, 'Missing required field: prompt');
    return;
  }

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Execute task
  try {
    await executeTask(
      {
        userId: body.user_id,
        taskId: body.task_id,
        skills: body.skills || [],
        prompt: body.prompt,
        context: body.context,
        files: body.files,
        timeout: body.timeout,
      },
      (event) => {
        sendSSE(res, event);
      }
    );

    res.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error, body }, 'Execute request failed');

    sendSSE(res, {
      type: 'error',
      message,
      code: 'INTERNAL_ERROR',
    });

    sendSSE(res, {
      type: 'complete',
      task_id: body.task_id,
      usage: { duration_ms: 0 },
    });

    res.end();
  }
}

/**
 * Handle skills list request
 */
function handleSkills(res: http.ServerResponse): void {
  const skills = getAvailableSkills();

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ skills }));
}

/**
 * Create HTTP server
 */
export function createServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Parse URL
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Validate API key
    const authResult = validateApiKey(req.headers);
    if (!authResult.success) {
      sendError(res, 401, authResult.error || 'Unauthorized');
      return;
    }

    // Route requests
    try {
      if (pathname === '/api/v1/execute' && req.method === 'POST') {
        await handleExecute(req, res);
      } else if (pathname === '/api/v1/skills' && req.method === 'GET') {
        handleSkills(res);
      } else {
        sendError(res, 404, 'Not found');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error, pathname }, 'Request handler error');
      sendError(res, 500, message);
    }
  });

  return server;
}

/**
 * Start HTTP server
 */
export function startServer(): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.listen(WEB_PORT, WEB_HOST, () => {
      logger.info(
        { host: WEB_HOST, port: WEB_PORT },
        'Web Channel HTTP server started'
      );
      resolve(server);
    });

    server.on('error', (err) => {
      logger.error({ error: err }, 'Failed to start Web Channel server');
      reject(err);
    });
  });
}

/**
 * Stop HTTP server
 */
export function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        logger.error({ error: err }, 'Error stopping Web Channel server');
        reject(err);
      } else {
        logger.info('Web Channel HTTP server stopped');
        resolve();
      }
    });
  });
}
