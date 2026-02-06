import fs from 'fs';
import path from 'path';
import { ConversationThread, ConversationMemory, ThreadMessage, Message, Channel } from '../types';
import { aiDebug } from '../utils/debugLogger';

export class ConversationThreadService {
  private memory: ConversationMemory;
  private memoryFilePath: string;
  private readonly THREAD_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
  private readonly MAX_THREADS_PER_CHANNEL = 10;
  private readonly MAX_THREAD_HISTORY = 50;

  constructor(memoryFilePath: string = './conversation-threads.json') {
    this.memoryFilePath = path.resolve(memoryFilePath);
    this.memory = this.loadMemory();
  }

  private loadMemory(): ConversationMemory {
    try {
      if (fs.existsSync(this.memoryFilePath)) {
        const data = fs.readFileSync(this.memoryFilePath, 'utf-8');
        const parsed = JSON.parse(data);
        // Convert date strings back to Date objects
        parsed.threads.forEach((thread: unknown) => {
          (thread as any).startTime = new Date((thread as any).startTime);
          (thread as any).lastActivity = new Date((thread as any).lastActivity);
          (thread as any).keyMessages.forEach((msg: unknown) => {
            (msg as any).timestamp = new Date((msg as any).timestamp);
          });
        });
        parsed.lastUpdated = new Date(parsed.lastUpdated);
        return parsed;
      }
    } catch (error) {
      aiDebug.error('Failed to load conversation memory:', error);
    }

    // Return default memory structure
    return {
      threads: [],
      activeThreads: {},
      threadHistory: {},
      lastUpdated: new Date()
    };
  }

  private saveMemory(): void {
    try {
      const dataToSave = {
        ...this.memory,
        lastUpdated: new Date()
      };
      fs.writeFileSync(this.memoryFilePath, JSON.stringify(dataToSave, null, 2), 'utf-8');
    } catch (error) {
      aiDebug.error('Failed to save conversation memory:', error);
    }
  }

  /**
   * Detects if a new conversation thread should be started based on recent messages
   */
  detectNewThread(channel: Channel, recentMessages: Message[]): ConversationThread | null {
    const botMessages = recentMessages.filter(msg =>
      msg.type === 'ai' || (msg.nickname && channel.users.find(u => u.nickname === msg.nickname)?.userType === 'bot')
    );

    if (botMessages.length < 2) {
      return null; // Need at least 2 bot messages to consider a thread
    }

    // Check if there's already an active thread in this channel
    const activeThread = this.memory.activeThreads[channel.name];
    if (activeThread && activeThread.status === 'active') {
      return null; // Don't start new thread if one is already active
    }

    // Analyze conversation patterns
    const participants = [...new Set(botMessages.map(msg => msg.nickname))];
    const timeSpan = recentMessages.length > 0 ?
      recentMessages[recentMessages.length - 1].timestamp.getTime() - recentMessages[0].timestamp.getTime() : 0;

    // Determine thread type
    let threadType: ConversationThread['threadType'] = 'general';
    if (participants.length >= 3) {
      threadType = 'multi_bot';
    } else if (participants.length === 2) {
      threadType = 'bot_to_bot';
    } else if (participants.length === 1 && botMessages.length >= 2) {
      threadType = 'bot_to_human'; // Bot responding to itself multiple times
    }

    // Extract topic from recent messages
    const topic = this.extractTopicFromMessages(recentMessages);

    // Create new thread
    const threadId = `thread_${channel.name}_${Date.now()}`;
    const thread: ConversationThread = {
      id: threadId,
      channel: channel.name,
      topic,
      participants,
      startTime: new Date(),
      lastActivity: new Date(),
      messageCount: botMessages.length,
      threadType,
      status: 'active',
      keyMessages: this.extractKeyMessages(recentMessages),
      tags: this.extractTags(recentMessages)
    };

    aiDebug.log(`Detected new conversation thread: ${threadId} (${threadType}) in ${channel.name}`);
    return thread;
  }

  /**
   * Updates an existing thread with new messages
   */
  updateThread(threadId: string, newMessages: Message[]): void {
    const thread = this.memory.threads.find(t => t.id === threadId);
    if (!thread) return;

    thread.lastActivity = new Date();
    thread.messageCount += newMessages.length;

    // Update key messages if new important messages are found
    const newKeyMessages = this.extractKeyMessages(newMessages);
    thread.keyMessages.push(...newKeyMessages);

    // Keep only the most recent key messages
    if (thread.keyMessages.length > 10) {
      thread.keyMessages = thread.keyMessages.slice(-10);
    }

    // Update tags
    const newTags = this.extractTags(newMessages);
    thread.tags = [...new Set([...thread.tags, ...newTags])];

    // Check if thread should be marked as completed or dormant
    const timeSinceLastActivity = Date.now() - thread.lastActivity.getTime();
    if (timeSinceLastActivity > this.THREAD_TIMEOUT_MS) {
      thread.status = 'dormant';
      aiDebug.log(`Thread ${threadId} marked as dormant due to inactivity`);
    }

    this.saveMemory();
  }

  /**
   * Gets the active thread for a channel
   */
  getActiveThread(channelName: string): ConversationThread | null {
    return this.memory.activeThreads[channelName] || null;
  }

  /**
   * Sets a thread as active for a channel
   */
  setActiveThread(channelName: string, thread: ConversationThread): void {
    this.memory.activeThreads[channelName] = thread;

    // Add to threads array if not already there
    if (!this.memory.threads.find(t => t.id === thread.id)) {
      this.memory.threads.push(thread);
    }

    // Maintain thread history limit
    if (!this.memory.threadHistory[channelName]) {
      this.memory.threadHistory[channelName] = [];
    }

    this.memory.threadHistory[channelName].push(thread);
    if (this.memory.threadHistory[channelName].length > this.MAX_THREAD_HISTORY) {
      this.memory.threadHistory[channelName] = this.memory.threadHistory[channelName].slice(-this.MAX_THREAD_HISTORY);
    }

    this.saveMemory();
  }

  /**
   * Gets conversation context for AI prompts
   */
  getConversationContext(channelName: string, currentBotNickname: string): string {
    const activeThread = this.getActiveThread(channelName);
    if (!activeThread) {
      return '';
    }

    let context = `\nCONVERSATION THREAD CONTEXT:
- Thread ID: ${activeThread.id}
- Topic: ${activeThread.topic}
- Participants: ${activeThread.participants.join(', ')}
- Thread Type: ${activeThread.threadType}
- Status: ${activeThread.status}
- Duration: ${Math.round((Date.now() - activeThread.startTime.getTime()) / 60000)} minutes
- Message Count: ${activeThread.messageCount}
- Tags: ${activeThread.tags.join(', ')}

KEY MESSAGES IN THREAD:
${activeThread.keyMessages.map(msg =>
    `[${msg.timestamp.toLocaleTimeString()}] ${msg.nickname}: ${msg.content} (${msg.importance} - ${msg.type})`
  ).join('\n')}

`;

    if (activeThread.summary) {
      context += `THREAD SUMMARY: ${activeThread.summary}\n\n`;
    }

    // Add guidance for continuing the thread
    if (activeThread.participants.includes(currentBotNickname)) {
      context += `THREAD CONTINUATION GUIDANCE:
- This is part of an ongoing conversation thread
- Maintain coherence with previous messages in this thread
- Reference or build upon the key points mentioned above
- Stay on topic: ${activeThread.topic}
- Your role in this thread: ${activeThread.threadType === 'bot_to_bot' ? 'Active participant in bot-to-bot discussion' : 'Contributor to multi-bot conversation'}

`;
    }

    return context;
  }

  /**
   * Generates a summary for a thread
   */
  async generateThreadSummary(thread: ConversationThread): Promise<string> {
    if (thread.keyMessages.length < 3) {
      return `Short conversation about ${thread.topic}`;
    }

    // Simple summary generation based on key messages
    const participants = thread.participants.join(' and ');
    const topic = thread.topic;
    const duration = Math.round((thread.lastActivity.getTime() - thread.startTime.getTime()) / 60000);

    return `${participants} discussed ${topic} for ${duration} minutes, covering ${thread.tags.slice(0, 3).join(', ')}`;
  }

  /**
   * Cleans up old/dormant threads
   */
  cleanupOldThreads(): void {
    const now = Date.now();
    const cutoffTime = now - (24 * 60 * 60 * 1000); // 24 hours ago

    // Mark old threads as completed
    this.memory.threads.forEach(thread => {
      if (thread.status === 'active' && (now - thread.lastActivity.getTime()) > this.THREAD_TIMEOUT_MS) {
        thread.status = 'completed';
        aiDebug.log(`Thread ${thread.id} marked as completed due to timeout`);
      }
    });

    // Remove very old threads from active threads
    Object.keys(this.memory.activeThreads).forEach(channelName => {
      const thread = this.memory.activeThreads[channelName];
      if (thread && (now - thread.lastActivity.getTime()) > cutoffTime) {
        delete this.memory.activeThreads[channelName];
        aiDebug.log(`Removed old active thread ${thread.id} from channel ${channelName}`);
      }
    });

    this.saveMemory();
  }

  private extractTopicFromMessages(messages: Message[]): string {
    const content = messages
      .filter(msg => 'content' in msg && msg.content)
      .map(msg => ('content' in msg ? msg.content : ''))
      .join(' ')
      .toLowerCase();

    // Simple topic extraction based on keywords
    const topics = [
      { keywords: ['programming', 'code', 'software', 'development', 'tech'], topic: 'programming/tech' },
      { keywords: ['music', 'song', 'band', 'artist', 'concert'], topic: 'music' },
      { keywords: ['game', 'gaming', 'play', 'player', 'esports'], topic: 'gaming' },
      { keywords: ['weather', 'temperature', 'rain', 'sunny'], topic: 'weather' },
      { keywords: ['food', 'eat', 'drink', 'restaurant', 'recipe'], topic: 'food/cooking' },
      { keywords: ['movie', 'film', 'cinema', 'actor', 'director'], topic: 'movies' },
      { keywords: ['book', 'read', 'author', 'novel', 'literature'], topic: 'books/reading' },
      { keywords: ['travel', 'vacation', 'trip', 'destination'], topic: 'travel' },
      { keywords: ['work', 'job', 'career', 'office', 'meeting'], topic: 'work/career' },
      { keywords: ['ai', 'artificial intelligence', 'machine learning', 'bot'], topic: 'AI/technology' }
    ];

    for (const { keywords, topic } of topics) {
      if (keywords.some(keyword => content.includes(keyword))) {
        return topic;
      }
    }

    return 'general conversation';
  }

  private extractKeyMessages(messages: Message[]): ThreadMessage[] {
    return messages
      .filter(msg => 'content' in msg && msg.content && msg.content.length > 10)
      .slice(-5) // Last 5 messages
      .map((msg, index) => ({
        id: 'id' in msg ? msg.id : Date.now() + index,
        nickname: msg.nickname,
        content: 'content' in msg ? msg.content! : '', // Use non-null assertion since we filtered for content
        timestamp: msg.timestamp,
        importance: index >= messages.length - 2 ? 'high' : 'medium', // Last 2 messages are high importance
        type: index === 0 ? 'initiating' : index === messages.length - 1 ? 'concluding' : 'continuing'
      }));
  }

  private extractTags(messages: Message[]): string[] {
    const content = messages
      .filter(msg => 'content' in msg && msg.content)
      .map(msg => ('content' in msg ? msg.content : ''))
      .join(' ')
      .toLowerCase();

    const tags: string[] = [];
    const tagKeywords = [
      'question', 'help', 'problem', 'solution', 'idea', 'opinion',
      'funny', 'serious', 'debate', 'discussion', 'agreement', 'disagreement',
      'technical', 'casual', 'philosophical', 'practical'
    ];

    tagKeywords.forEach(keyword => {
      if (content.includes(keyword)) {
        tags.push(keyword);
      }
    });

    return [...new Set(tags)].slice(0, 5); // Max 5 tags
  }

  /**
   * Gets thread statistics for debugging
   */
  getStats(): { totalThreads: number; activeThreads: number; channels: string[] } {
    return {
      totalThreads: this.memory.threads.length,
      activeThreads: Object.keys(this.memory.activeThreads).length,
      channels: Object.keys(this.memory.threadHistory)
    };
  }
}

// Export singleton instance
export const conversationThreadService = new ConversationThreadService();
