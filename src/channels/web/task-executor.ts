/**
 * Web Channel Task Executor
 * Manages task lifecycle: directory creation, skill injection, container execution, cleanup
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { GROUPS_DIR, SHARED_UPLOADS_DIR } from '../../config.js';
import { runContainerAgent } from '../../container-runner.js';
import { logger } from '../../logger.js';
import { RegisteredGroup } from '../../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ContextMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ExecuteOptions {
  userId: string;
  taskId: string;
  skills: string[];
  prompt: string;
  context?: {
    messages?: ContextMessage[];
    summary?: string;
  };
  files?: string[];
  timeout?: number;
}

export type SSEEvent =
  | { type: 'start'; user_id: string; task_id: string; timestamp: string }
  | { type: 'thinking'; content: string }
  | { type: 'content'; content: string }
  | { type: 'tool_start'; tool: string; input: unknown }
  | { type: 'tool_complete'; tool: string; output?: unknown }
  | { type: 'file'; path: string; name: string }
  | { type: 'error'; message: string; code?: string }
  | { type: 'complete'; task_id: string; usage: { duration_ms: number; tokens_input?: number; tokens_output?: number } };

interface SkillInfo {
  name: string;
  description: string;
}

/**
 * Build system prompt from context and user prompt
 */
function buildPrompt(userPrompt: string, context?: ExecuteOptions['context']): string {
  const parts: string[] = [];

  // Add context summary if provided
  if (context?.summary) {
    parts.push(`<context_summary>${context.summary}</context_summary>`);
  }

  // Add conversation history
  if (context?.messages?.length) {
    for (const msg of context.messages) {
      parts.push(`<${msg.role}>${msg.content}</${msg.role}>`);
    }
  }

  // Add current user prompt
  parts.push(`<user>${userPrompt}</user>`);

  return parts.join('\n\n');
}

/**
 * Get skill templates directory path
 */
function getSkillTemplatesDir(): string {
  const projectRoot = process.cwd();
  return path.join(projectRoot, 'skill-templates');
}

/**
 * Copy skill templates to task directory
 */
function copySkills(skills: string[], taskSkillsDir: string): void {
  const templatesDir = getSkillTemplatesDir();

  if (!fs.existsSync(templatesDir)) {
    logger.debug('No skill-templates directory found');
    return;
  }

  fs.mkdirSync(taskSkillsDir, { recursive: true });

  for (const skill of skills) {
    const skillFile = `${skill}.md`;
    const srcPath = path.join(templatesDir, skill, skillFile);
    const dstPath = path.join(taskSkillsDir, skillFile);

    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, dstPath);
      logger.debug({ skill, src: srcPath, dst: dstPath }, 'Copied skill template');
    } else {
      logger.warn({ skill, path: srcPath }, 'Skill template not found');
    }
  }
}

/**
 * Create file symlinks in task directory
 */
function createFileLinks(files: string[], taskUploadsDir: string): void {
  fs.mkdirSync(taskUploadsDir, { recursive: true });

  for (const filePath of files) {
    // Validate file path is within shared uploads directory
    const resolvedPath = path.resolve(filePath);
    const uploadsDir = path.resolve(SHARED_UPLOADS_DIR);

    if (!resolvedPath.startsWith(uploadsDir)) {
      logger.warn({ filePath }, 'File path outside shared uploads directory, skipping');
      continue;
    }

    if (!fs.existsSync(resolvedPath)) {
      logger.warn({ filePath }, 'File does not exist, skipping');
      continue;
    }

    const fileName = path.basename(resolvedPath);
    const linkPath = path.join(taskUploadsDir, fileName);

    try {
      fs.symlinkSync(resolvedPath, linkPath);
      logger.debug({ filePath, linkPath }, 'Created file symlink');
    } catch (err) {
      logger.warn({ filePath, error: err }, 'Failed to create file symlink');
    }
  }
}

/**
 * Generate CLAUDE.md for the task
 */
function generateClaudeMd(taskDir: string, skills: string[]): void {
  const skillsSection = skills.length > 0
    ? `\n## Available Skills\n\n${skills.map(s => `- ${s}`).join('\n')}`
    : '';

  const content = `# Task Session

This is a web channel task session.${skillsSection}

## File Access

Uploaded files are available in the /workspace/group/uploads/ directory.
`;

  fs.writeFileSync(path.join(taskDir, 'CLAUDE.md'), content);
}

/**
 * Clean up task directory
 */
function cleanupTaskDir(taskDir: string): void {
  try {
    fs.rmSync(taskDir, { recursive: true, force: true });
    logger.debug({ taskDir }, 'Cleaned up task directory');
  } catch (err) {
    logger.warn({ taskDir, error: err }, 'Failed to clean up task directory');
  }
}

/**
 * Execute a task with Agent
 */
export async function executeTask(
  options: ExecuteOptions,
  onEvent: (event: SSEEvent) => void
): Promise<void> {
  const startTime = Date.now();
  const { userId, taskId, skills, prompt, context, files } = options;

  // Create task directory (use web_${userId} to match group folder naming)
  const userDir = path.join(GROUPS_DIR, `web_${userId}`);
  const taskDir = path.join(userDir, 'tasks', taskId);
  const taskSkillsDir = path.join(taskDir, 'skills');
  const taskUploadsDir = path.join(taskDir, 'uploads');

  try {
    fs.mkdirSync(taskDir, { recursive: true });
    logger.debug({ taskDir }, 'Created task directory');

    // Copy skill templates
    if (skills.length > 0) {
      copySkills(skills, taskSkillsDir);
    }

    // Create file symlinks
    if (files && files.length > 0) {
      createFileLinks(files, taskUploadsDir);
    }

    // Generate CLAUDE.md
    generateClaudeMd(taskDir, skills);

    // Build prompt with context
    const fullPrompt = buildPrompt(prompt, context);

    // Create a mock RegisteredGroup for container execution
    // Note: folder must be a valid name (no /, \, ..)
    const group: RegisteredGroup = {
      folder: `web_${userId}`,
      name: `web-${userId}`,
      trigger: '',
      added_at: new Date().toISOString(),
      isMain: false,
      containerConfig: {
        timeout: options.timeout,
      },
    };

    // Send start event
    onEvent({
      type: 'start',
      user_id: userId,
      task_id: taskId,
      timestamp: new Date().toISOString(),
    });

    // Track accumulated content for complete event
    let accumulatedContent = '';

    // Execute container agent
    const result = await runContainerAgent(
      group,
      {
        prompt: fullPrompt,
        sessionId: undefined,
        groupFolder: group.folder,
        chatJid: `web:${userId}:${taskId}`,
        isMain: false,
        assistantName: 'Assistant',
      },
      (proc, containerName) => {
        logger.debug({ containerName }, 'Container started');
      },
      async (output) => {
        // Convert container output to SSE events
        if (output.result) {
          accumulatedContent += output.result;
          onEvent({
            type: 'content',
            content: output.result,
          });
        }

        if (output.error) {
          onEvent({
            type: 'error',
            message: output.error,
          });
        }
      }
    );

    const duration = Date.now() - startTime;

    // Send complete event
    onEvent({
      type: 'complete',
      task_id: taskId,
      usage: {
        duration_ms: duration,
      },
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error, userId, taskId }, 'Task execution failed');

    onEvent({
      type: 'error',
      message: errorMessage,
      code: 'EXECUTION_ERROR',
    });

    onEvent({
      type: 'complete',
      task_id: taskId,
      usage: {
        duration_ms: Date.now() - startTime,
      },
    });

  } finally {
    // Clean up task directory
    cleanupTaskDir(taskDir);
  }
}

/**
 * Get available skills from skill-templates directory
 */
export function getAvailableSkills(): SkillInfo[] {
  const templatesDir = getSkillTemplatesDir();

  if (!fs.existsSync(templatesDir)) {
    return [];
  }

  const skills: SkillInfo[] = [];

  for (const entry of fs.readdirSync(templatesDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      skills.push({
        name: entry.name,
        description: getSkillDescription(entry.name, templatesDir),
      });
    }
  }

  return skills;
}

/**
 * Get skill description from skill file
 */
function getSkillDescription(skillName: string, templatesDir: string): string {
  const skillFile = path.join(templatesDir, skillName, `${skillName}.md`);

  if (!fs.existsSync(skillFile)) {
    return '';
  }

  try {
    const content = fs.readFileSync(skillFile, 'utf-8');
    // Extract first line as description (assuming it starts with # for title)
    const firstLine = content.split('\n')[0];
    if (firstLine?.startsWith('#')) {
      return firstLine.replace(/^#+\s*/, '').trim();
    }
    return '';
  } catch {
    return '';
  }
}
