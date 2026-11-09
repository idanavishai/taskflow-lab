export const MAX_MESSAGE = 64 * 1024;
export const MAX_OUTPUT = 1024 * 1024;

export function validateToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new TypeError('token must contain 32 to 256 letters, digits, underscores, or hyphens');
  }
}

export function parseMessage(data) {
  try {
    const message = JSON.parse(data.toString());
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      throw new Error('missing message type');
    }
    return message;
  } catch {
    throw new Error('Invalid shell protocol message');
  }
}

export function decodeData(message) {
  if (typeof message.data !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data)) {
    throw new Error('Invalid shell protocol base64 data');
  }
  return Buffer.from(message.data, 'base64');
}
