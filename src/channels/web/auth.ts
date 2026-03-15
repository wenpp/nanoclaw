/**
 * Web Channel Authentication
 * Simple shared secret via X-API-Key header
 */
import { WEB_API_KEY } from '../../config.js';
import { logger } from '../../logger.js';

export interface AuthResult {
  success: boolean;
  error?: string;
}

/**
 * Validate API Key from request headers
 */
export function validateApiKey(headers: Record<string, string | string[] | undefined>): AuthResult {
  // If no API key is configured, allow all requests (development mode)
  if (!WEB_API_KEY) {
    logger.debug('No WEB_API_KEY configured, allowing all requests');
    return { success: true };
  }

  const providedKey = headers['x-api-key'] || headers['X-API-Key'];

  if (!providedKey) {
    logger.warn('API request missing X-API-Key header');
    return { success: false, error: 'Missing X-API-Key header' };
  }

  if (providedKey !== WEB_API_KEY) {
    logger.warn('API request with invalid X-API-Key');
    return { success: false, error: 'Invalid API key' };
  }

  return { success: true };
}
