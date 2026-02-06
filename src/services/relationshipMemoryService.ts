import type { User, UserRelationship, UserRelationshipMemory, InteractionRecord, Message } from '../types';
import { aiDebug } from '../utils/debugLogger';

/**
 * Service for managing AI user relationship memory across channels
 * Tracks interactions between virtual users and human users to create more realistic relationships
 */

// Initialize relationship memory for a user if it doesn't exist
export const initializeRelationshipMemory = (user: User): User => {
  if (!user.relationshipMemory) {
    return {
      ...user,
      relationshipMemory: {
        relationships: {},
        lastUpdated: new Date()
      }
    };
  }
  
  // Ensure dates in relationships are Date objects (they might be strings from storage)
  if (user.relationshipMemory.relationships) {
    const relationships = user.relationshipMemory.relationships;
    Object.keys(relationships).forEach(nickname => {
      const relationship = relationships[nickname];
      if (relationship) {
        if (!(relationship.firstMet instanceof Date)) {
          relationship.firstMet = new Date(relationship.firstMet);
        }
        if (!(relationship.lastInteraction instanceof Date)) {
          relationship.lastInteraction = new Date(relationship.lastInteraction);
        }
        // Convert timestamps in interaction history
        if (relationship.interactionHistory) {
          relationship.interactionHistory = relationship.interactionHistory.map(interaction => ({
            ...interaction,
            timestamp: interaction.timestamp instanceof Date ? interaction.timestamp : new Date(interaction.timestamp)
          }));
        }
      }
    });
  }
  
  // Ensure lastUpdated is a Date object
  if (user.relationshipMemory.lastUpdated && !(user.relationshipMemory.lastUpdated instanceof Date)) {
    user.relationshipMemory.lastUpdated = new Date(user.relationshipMemory.lastUpdated);
  }
  
  return user;
};

// Update relationship memory when users interact
export const updateRelationshipMemory = (
  aiUser: User,
  otherUserNickname: string,
  channel: string,
  message: Message,
  interactionType: InteractionRecord['interactionType'] = 'message_exchange'
): User => {
  const userWithMemory = initializeRelationshipMemory(aiUser);
  const memory = userWithMemory.relationshipMemory!;
  
  // Get or create relationship
  let relationship = memory.relationships[otherUserNickname];
  if (!relationship) {
    relationship = {
      nickname: otherUserNickname,
      relationshipLevel: 'stranger',
      sharedChannels: [],
      interactionCount: 0,
      lastInteraction: new Date(),
      firstMet: new Date(),
      sharedTopics: [],
      interactionHistory: []
    };
    memory.relationships[otherUserNickname] = relationship;
  }

  // Ensure dates are Date objects (they might be strings from storage)
  if (!(relationship.firstMet instanceof Date)) {
    relationship.firstMet = new Date(relationship.firstMet);
  }
  if (!(relationship.lastInteraction instanceof Date)) {
    relationship.lastInteraction = new Date(relationship.lastInteraction);
  }

  // Update relationship data
  relationship.interactionCount++;
  relationship.lastInteraction = new Date();
  
  // Add channel if not already present
  if (!relationship.sharedChannels.includes(channel)) {
    relationship.sharedChannels.push(channel);
  }

  // Add interaction record
  let context = '';
  let sentiment: InteractionRecord['sentiment'] = 'neutral';

  if ('content' in message && typeof message.content === 'string') {
    context = message.content.substring(0, 100);
    sentiment = analyzeSentiment(message.content);
  }

  const interactionRecord: InteractionRecord = {
    timestamp: new Date(),
    channel,
    interactionType,
    context,
    sentiment
  };

  relationship.interactionHistory.push(interactionRecord);
  
  // Keep only last 20 interactions to prevent memory bloat
  if (relationship.interactionHistory.length > 20) {
    relationship.interactionHistory = relationship.interactionHistory.slice(-20);
  }

  // Update relationship level based on interaction count and frequency
  relationship.relationshipLevel = calculateRelationshipLevel(relationship);

  // Extract topics from message content
  if ('content' in message && typeof message.content === 'string') {
    const topics = extractTopicsFromMessage(message.content);
    topics.forEach(topic => {
      if (!relationship.sharedTopics.includes(topic)) {
        relationship.sharedTopics.push(topic);
      }
    });
  }

  // Keep only last 10 topics
  if (relationship.sharedTopics.length > 10) {
    relationship.sharedTopics = relationship.sharedTopics.slice(-10);
  }

  memory.lastUpdated = new Date();

  aiDebug.log(`Updated relationship memory for ${aiUser.nickname} -> ${otherUserNickname}:`, {
    relationshipLevel: relationship.relationshipLevel,
    interactionCount: relationship.interactionCount,
    sharedChannels: relationship.sharedChannels.length,
    sharedTopics: relationship.sharedTopics.length
  });

  return userWithMemory;
};

// Calculate relationship level based on interaction patterns
const calculateRelationshipLevel = (relationship: UserRelationship): UserRelationship['relationshipLevel'] => {
  const { interactionCount, lastInteraction, firstMet } = relationship;
  
  // Debugging: Log the type and value of firstMet
  aiDebug.log(`[calculateRelationshipLevel] firstMet value: ${firstMet}, type: ${typeof firstMet}`);

  // Ensure dates are Date objects (they might be strings from storage)
  const firstMetDate = new Date(firstMet);
  const lastInteractionDate = new Date(lastInteraction);
  
  // Calculate days since first meeting
  const daysSinceFirstMet = Math.floor((Date.now() - firstMetDate.getTime()) / (1000 * 60 * 60 * 24));
  
  // Calculate days since last interaction
  const daysSinceLastInteraction = Math.floor((Date.now() - lastInteractionDate.getTime()) / (1000 * 60 * 60 * 24));
  
  // Relationship decay: if no interaction for 7+ days, relationship cools down
  if (daysSinceLastInteraction > 7) {
    if (relationship.relationshipLevel === 'close') return 'friendly';
    if (relationship.relationshipLevel === 'friendly') return 'acquaintance';
    if (relationship.relationshipLevel === 'acquaintance') return 'stranger';
  }
  
  // Relationship progression based on interaction count and frequency
  if (interactionCount >= 50 && daysSinceFirstMet >= 3) return 'close';
  if (interactionCount >= 20 && daysSinceFirstMet >= 1) return 'friendly';
  if (interactionCount >= 5) return 'acquaintance';
  
  return 'stranger';
};

// Analyze sentiment of a message (simple keyword-based approach)
const analyzeSentiment = (content: string): InteractionRecord['sentiment'] => {
  const positiveWords = ['thanks', 'thank you', 'great', 'awesome', 'cool', 'nice', 'good', 'love', 'like', 'appreciate', 'helpful', 'amazing', 'wonderful', 'excellent', 'fantastic'];
  const negativeWords = ['hate', 'stupid', 'bad', 'terrible', 'awful', 'annoying', 'boring', 'wrong', 'disagree', 'angry', 'mad', 'frustrated', 'disappointed'];
  
  const lowerContent = content.toLowerCase();
  
  const positiveCount = positiveWords.filter(word => lowerContent.includes(word)).length;
  const negativeCount = negativeWords.filter(word => lowerContent.includes(word)).length;
  
  if (positiveCount > negativeCount) return 'positive';
  if (negativeCount > positiveCount) return 'negative';
  return 'neutral';
};

// Extract topics from message content (simple keyword extraction)
const extractTopicsFromMessage = (content: string): string[] => {
  const topics: string[] = [];
  const lowerContent = content.toLowerCase();
  
  // Common topic keywords
  const topicKeywords = {
    'programming': ['code', 'programming', 'coding', 'developer', 'software', 'bug', 'debug', 'function', 'variable', 'api', 'javascript', 'python', 'react', 'node'],
    'gaming': ['game', 'gaming', 'play', 'player', 'level', 'score', 'quest', 'rpg', 'fps', 'multiplayer', 'steam', 'console'],
    'music': ['music', 'song', 'band', 'album', 'concert', 'guitar', 'piano', 'drum', 'spotify', 'youtube', 'sound'],
    'movies': ['movie', 'film', 'cinema', 'actor', 'director', 'netflix', 'hulu', 'disney', 'marvel', 'dc'],
    'sports': ['sport', 'football', 'basketball', 'soccer', 'tennis', 'golf', 'team', 'player', 'match', 'game'],
    'food': ['food', 'eat', 'restaurant', 'cooking', 'recipe', 'pizza', 'burger', 'coffee', 'tea', 'breakfast', 'lunch', 'dinner'],
    'travel': ['travel', 'trip', 'vacation', 'hotel', 'flight', 'airplane', 'city', 'country', 'beach', 'mountain'],
    'technology': ['tech', 'technology', 'computer', 'phone', 'internet', 'ai', 'machine learning', 'data', 'cloud', 'server'],
    'books': ['book', 'reading', 'novel', 'author', 'story', 'chapter', 'library', 'kindle', 'ebook'],
    'art': ['art', 'painting', 'drawing', 'artist', 'gallery', 'museum', 'creative', 'design', 'color', 'canvas']
  };
  
  Object.entries(topicKeywords).forEach(([topic, keywords]) => {
    if (keywords.some(keyword => lowerContent.includes(keyword))) {
      topics.push(topic);
    }
  });
  
  return topics;
};

// Get relationship context for AI prompts
export const getRelationshipContext = (
  aiUser: User,
  otherUserNickname: string,
  currentChannel: string
): string => {
  const memory = aiUser.relationshipMemory;
  if (!memory) return '';

  const relationship = memory.relationships[otherUserNickname];
  if (!relationship) return '';

  // Ensure all date fields are Date objects (they might be strings from storage)
  if (!(relationship.firstMet instanceof Date)) {
    relationship.firstMet = new Date(relationship.firstMet);
  }
  if (!(relationship.lastInteraction instanceof Date)) {
    relationship.lastInteraction = new Date(relationship.lastInteraction);
  }
  // Convert timestamps in interaction history
  if (relationship.interactionHistory) {
    relationship.interactionHistory = relationship.interactionHistory.map(interaction => ({
      ...interaction,
      timestamp: interaction.timestamp instanceof Date ? interaction.timestamp : new Date(interaction.timestamp)
    }));
  }

  const context = [];
  
  // Basic relationship info
  context.push(`Relationship Level: ${relationship.relationshipLevel}`);
  context.push(`Interactions: ${relationship.interactionCount} total`);
  
  // Channel context
  if (relationship.sharedChannels.includes(currentChannel)) {
    context.push(`You've interacted with ${otherUserNickname} in ${currentChannel} before`);
  } else {
    context.push(`This is your first interaction with ${otherUserNickname} in ${currentChannel}`);
  }
  
  // Recent interaction context
  const recentInteractions = relationship.interactionHistory.slice(-3);
  if (recentInteractions.length > 0) {
    context.push(`Recent interactions: ${recentInteractions.map(i => i.context.substring(0, 50)).join(', ')}`);
  }
  
  // Shared topics
  if (relationship.sharedTopics.length > 0) {
    context.push(`Shared interests: ${relationship.sharedTopics.join(', ')}`);
  }
  
  // Time context
  // Ensure lastInteraction is a Date object before calling getTime()
  // Ensure lastInteraction is a valid Date object before calling getTime()
  if (typeof relationship.lastInteraction === 'string') {
    relationship.lastInteraction = new Date(relationship.lastInteraction);
  }
  
  const daysSinceLastInteraction = Math.floor((Date.now() - relationship.lastInteraction.getTime()) / (1000 * 60 * 60 * 24));
  if (daysSinceLastInteraction > 0) {
    context.push(`Last interaction: ${daysSinceLastInteraction} day${daysSinceLastInteraction > 1 ? 's' : ''} ago`);
  } else {
    context.push('Last interaction: today');
  }

  return context.join('. ') + '.';
};

// Update multiple users' relationship memory when they interact in a channel
export const updateChannelRelationshipMemory = (
  users: User[],
  message: Message,
  channel: string
): User[] => {
  return users.map(user => {
    // Only update memory for virtual users
    if (user.userType !== 'virtual') return user;
    
    // Don't update memory for the message sender
    if (user.nickname === message.nickname) return user;
    
    // Update relationship memory with the message sender
    return updateRelationshipMemory(user, message.nickname, channel, message);
  });
};

// Get relationship summary for debugging
export const getRelationshipSummary = (user: User): string => {
  const memory = user.relationshipMemory;
  if (!memory) return 'No relationship memory';

  const relationships = Object.values(memory.relationships);
  const summary = relationships.map(rel => 
    `${(rel as UserRelationship).nickname}: ${(rel as UserRelationship).relationshipLevel} (${(rel as UserRelationship).interactionCount} interactions)`
  ).join(', ');

  return summary || 'No relationships tracked';
};
