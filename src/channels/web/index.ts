/**
 * Web Channel
 * HTTP + SSE interface for external web applications
 */
import http from 'http';

import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../../types.js';
import { logger } from '../../logger.js';
import { registerChannel } from '../registry.js';
import { WEB_API_KEY } from '../../config.js';
import { startServer, stopServer } from './server.js';

class WebChannel implements Channel {
  name = 'web';
  private server: http.Server | null = null;
  private connected = false;

  async connect(): Promise<void> {
    // Skip if no API key is configured (web channel is optional)
    if (!WEB_API_KEY) {
      logger.info('Web Channel not configured (WEB_API_KEY not set), skipping');
      return;
    }

    try {
      this.server = await startServer();
      this.connected = true;
    } catch (err) {
      logger.error({ error: err }, 'Failed to start Web Channel');
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await stopServer(this.server);
      this.server = null;
    }
    this.connected = false;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Web Channel messages are sent via SSE stream
    // This method is not used directly but required by Channel interface
    logger.debug({ jid, textLength: text.length }, 'WebChannel sendMessage called');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('web:');
  }
}

interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

// Register the channel
registerChannel('web', (_opts: ChannelOpts) => {
  // Web channel doesn't use the standard message callbacks
  // It handles everything via HTTP requests
  return new WebChannel();
});

export { WebChannel };
