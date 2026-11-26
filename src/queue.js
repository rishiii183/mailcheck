import PQueue from 'p-queue';

class SendQueueManager {
  constructor() {
    // Global send queue: limits overall concurrent outbound SMTP connections
    this.globalQueue = new PQueue({ concurrency: 5 });
    
    // Per-host queues: rate limit outbound sends to the same SMTP server
    this.hostQueues = new Map();
  }

  getHostQueue(host) {
    const key = (host || 'default').toLowerCase().trim();
    if (!this.hostQueues.has(key)) {
      // 1 concurrent send per host at a time, min 1000ms interval
      const q = new PQueue({
        concurrency: 1,
        interval: 1000,
        intervalCap: 1
      });
      this.hostQueues.set(key, q);
    }
    return this.hostQueues.get(key);
  }

  /**
   * Schedule an outbound send task respecting both per-host and global limits
   * @param {string} host 
   * @param {Function} task 
   */
  async enqueue(host, task) {
    const hostQ = this.getHostQueue(host);
    return this.globalQueue.add(() => hostQ.add(task));
  }

  clear() {
    this.globalQueue.clear();
    for (const q of this.hostQueues.values()) {
      q.clear();
    }
  }
}

export const sendQueue = new SendQueueManager();
