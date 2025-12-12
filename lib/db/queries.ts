import "server-only";

import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  type SQL,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { ArtifactKind } from "@/components/artifact";
import type { VisibilityType } from "@/components/visibility-selector";
import { ChatSDKError } from "../errors";
import type { AppUsage } from "../usage";
import { generateUUID } from "../utils";
import {
  type Chat,
  chat,
  type DBMessage,
  document,
  message,
  type Suggestion,
  stream,
  suggestion,
  type User,
  user,
  vote,
  type Vote,
  type Document,
} from "./schema";
import { generateHashedPassword } from "./utils";

// Optionally, if not using email/pass login, you can
// use the Drizzle adapter for Auth.js / NextAuth
// https://authjs.dev/reference/adapter/drizzle

const IS_MOCK_MODE = !process.env.POSTGRES_URL;

let client;
let db: any;

if (!IS_MOCK_MODE) {
  // biome-ignore lint: Forbidden non-null assertion.
  client = postgres(process.env.POSTGRES_URL!);
  db = drizzle(client);
}

// Mock Data Store
const mockStore = {
  users: [] as User[],
  chats: [] as Chat[],
  messages: [] as DBMessage[],
  votes: [] as Vote[],
  documents: [] as Document[],
  suggestions: [] as Suggestion[],
  streams: [] as any[], // Using any to simplify mock type matching
};

export async function getUser(email: string): Promise<User[]> {
  if (IS_MOCK_MODE) {
    return mockStore.users.filter((u) => u.email === email);
  }

  try {
    return await db.select().from(user).where(eq(user.email, email));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get user by email"
    );
  }
}

export async function createUser(email: string, password: string) {
  const hashedPassword = generateHashedPassword(password);

  if (IS_MOCK_MODE) {
    const newUser: User = {
      id: generateUUID(),
      email,
      password: hashedPassword,
    };
    mockStore.users.push(newUser);
    return [newUser]; // Return array to match drizzle insert returning behavior
  }

  try {
    return await db.insert(user).values({ email, password: hashedPassword });
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to create user");
  }
}

export async function createGuestUser() {
  const email = `guest-${Date.now()}`;
  const password = generateHashedPassword(generateUUID());

  if (IS_MOCK_MODE) {
    const newUser: User = {
      id: generateUUID(),
      email,
      password,
    };
    mockStore.users.push(newUser);
    return [{ id: newUser.id, email: newUser.email }];
  }

  try {
    return await db.insert(user).values({ email, password }).returning({
      id: user.id,
      email: user.email,
    });
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to create guest user"
    );
  }
}

export async function saveChat({
  id,
  userId,
  title,
  visibility,
}: {
  id: string;
  userId: string;
  title: string;
  visibility: VisibilityType;
}) {
  if (IS_MOCK_MODE) {
    const newChat: Chat = {
      id,
      createdAt: new Date(),
      userId,
      title,
      visibility,
      lastContext: null,
    };
    const existingChatIndex = mockStore.chats.findIndex((c) => c.id === id);
    if (existingChatIndex >= 0) {
        mockStore.chats[existingChatIndex] = { ...mockStore.chats[existingChatIndex], ...newChat };
    } else {
        mockStore.chats.push(newChat);
    }
    return [newChat];
  }

  try {
    return await db.insert(chat).values({
      id,
      createdAt: new Date(),
      userId,
      title,
      visibility,
    });
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to save chat");
  }
}

export async function deleteChatById({ id }: { id: string }) {
  if (IS_MOCK_MODE) {
    mockStore.votes = mockStore.votes.filter((v) => v.chatId !== id);
    mockStore.messages = mockStore.messages.filter((m) => m.chatId !== id);
    mockStore.streams = mockStore.streams.filter((s) => s.chatId !== id);
    const chatsDeleted = mockStore.chats.filter((c) => c.id === id);
    mockStore.chats = mockStore.chats.filter((c) => c.id !== id);
    return chatsDeleted.length > 0 ? chatsDeleted[0] : undefined;
  }

  try {
    await db.delete(vote).where(eq(vote.chatId, id));
    await db.delete(message).where(eq(message.chatId, id));
    await db.delete(stream).where(eq(stream.chatId, id));

    const [chatsDeleted] = await db
      .delete(chat)
      .where(eq(chat.id, id))
      .returning();
    return chatsDeleted;
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to delete chat by id"
    );
  }
}

export async function deleteAllChatsByUserId({ userId }: { userId: string }) {
  if (IS_MOCK_MODE) {
    const userChats = mockStore.chats.filter((c) => c.userId === userId);
    const chatIds = userChats.map((c) => c.id);

    mockStore.votes = mockStore.votes.filter(
      (v) => !chatIds.includes(v.chatId)
    );
    mockStore.messages = mockStore.messages.filter(
      (m) => !chatIds.includes(m.chatId)
    );
    mockStore.streams = mockStore.streams.filter(
      (s) => !chatIds.includes(s.chatId)
    );
    mockStore.chats = mockStore.chats.filter((c) => c.userId !== userId);

    return { deletedCount: userChats.length };
  }

  try {
    const userChats = await db
      .select({ id: chat.id })
      .from(chat)
      .where(eq(chat.userId, userId));

    if (userChats.length === 0) {
      return { deletedCount: 0 };
    }

    const chatIds = userChats.map((c: any) => c.id);

    await db.delete(vote).where(inArray(vote.chatId, chatIds));
    await db.delete(message).where(inArray(message.chatId, chatIds));
    await db.delete(stream).where(inArray(stream.chatId, chatIds));

    const deletedChats = await db
      .delete(chat)
      .where(eq(chat.userId, userId))
      .returning();

    return { deletedCount: deletedChats.length };
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to delete all chats by user id"
    );
  }
}

export async function getChatsByUserId({
  id,
  limit,
  startingAfter,
  endingBefore,
}: {
  id: string;
  limit: number;
  startingAfter: string | null;
  endingBefore: string | null;
}) {
  if (IS_MOCK_MODE) {
    let filteredChats = mockStore.chats
      .filter((c) => c.userId === id)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    if (startingAfter) {
      const selectedChat = mockStore.chats.find((c) => c.id === startingAfter);
      if (selectedChat) {
        filteredChats = filteredChats.filter(
          (c) => c.createdAt.getTime() < selectedChat.createdAt.getTime()
        );
      }
    } else if (endingBefore) {
      const selectedChat = mockStore.chats.find((c) => c.id === endingBefore);
      if (selectedChat) {
        filteredChats = filteredChats.filter(
          (c) => c.createdAt.getTime() > selectedChat.createdAt.getTime()
        );
      }
    }

    const hasMore = filteredChats.length > limit;
    return {
      chats: hasMore ? filteredChats.slice(0, limit) : filteredChats,
      hasMore,
    };
  }

  try {
    const extendedLimit = limit + 1;

    const query = (whereCondition?: SQL<any>) =>
      db
        .select()
        .from(chat)
        .where(
          whereCondition
            ? and(whereCondition, eq(chat.userId, id))
            : eq(chat.userId, id)
        )
        .orderBy(desc(chat.createdAt))
        .limit(extendedLimit);

    let filteredChats: Chat[] = [];

    if (startingAfter) {
      const [selectedChat] = await db
        .select()
        .from(chat)
        .where(eq(chat.id, startingAfter))
        .limit(1);

      if (!selectedChat) {
        throw new ChatSDKError(
          "not_found:database",
          `Chat with id ${startingAfter} not found`
        );
      }

      filteredChats = await query(gt(chat.createdAt, selectedChat.createdAt));
    } else if (endingBefore) {
      const [selectedChat] = await db
        .select()
        .from(chat)
        .where(eq(chat.id, endingBefore))
        .limit(1);

      if (!selectedChat) {
        throw new ChatSDKError(
          "not_found:database",
          `Chat with id ${endingBefore} not found`
        );
      }

      filteredChats = await query(lt(chat.createdAt, selectedChat.createdAt));
    } else {
      filteredChats = await query();
    }

    const hasMore = filteredChats.length > limit;

    return {
      chats: hasMore ? filteredChats.slice(0, limit) : filteredChats,
      hasMore,
    };
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get chats by user id"
    );
  }
}

export async function getChatById({ id }: { id: string }) {
  if (IS_MOCK_MODE) {
    return mockStore.chats.find((c) => c.id === id) || null;
  }

  try {
    const [selectedChat] = await db.select().from(chat).where(eq(chat.id, id));
    if (!selectedChat) {
      return null;
    }

    return selectedChat;
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to get chat by id");
  }
}

export async function saveMessages({ messages }: { messages: DBMessage[] }) {
  if (IS_MOCK_MODE) {
    for (const msg of messages) {
       // Check if message exists to update or push
       const idx = mockStore.messages.findIndex(m => m.id === msg.id);
       if (idx >= 0) {
           mockStore.messages[idx] = msg;
       } else {
           mockStore.messages.push(msg);
       }
    }
    return messages;
  }

  try {
    return await db.insert(message).values(messages);
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to save messages");
  }
}

export async function getMessagesByChatId({ id }: { id: string }) {
  if (IS_MOCK_MODE) {
    return mockStore.messages
      .filter((m) => m.chatId === id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  try {
    return await db
      .select()
      .from(message)
      .where(eq(message.chatId, id))
      .orderBy(asc(message.createdAt));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get messages by chat id"
    );
  }
}

export async function voteMessage({
  chatId,
  messageId,
  type,
}: {
  chatId: string;
  messageId: string;
  type: "up" | "down";
}) {
  if (IS_MOCK_MODE) {
    const existingVoteIndex = mockStore.votes.findIndex(
      (v) => v.messageId === messageId
    );
    if (existingVoteIndex >= 0) {
      mockStore.votes[existingVoteIndex].isUpvoted = type === "up";
      return [mockStore.votes[existingVoteIndex]];
    }
    const newVote = { chatId, messageId, isUpvoted: type === "up" };
    mockStore.votes.push(newVote);
    return [newVote];
  }

  try {
    const [existingVote] = await db
      .select()
      .from(vote)
      .where(and(eq(vote.messageId, messageId)));

    if (existingVote) {
      return await db
        .update(vote)
        .set({ isUpvoted: type === "up" })
        .where(and(eq(vote.messageId, messageId), eq(vote.chatId, chatId)));
    }
    return await db.insert(vote).values({
      chatId,
      messageId,
      isUpvoted: type === "up",
    });
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to vote message");
  }
}

export async function getVotesByChatId({ id }: { id: string }) {
  if (IS_MOCK_MODE) {
    return mockStore.votes.filter((v) => v.chatId === id);
  }

  try {
    return await db.select().from(vote).where(eq(vote.chatId, id));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get votes by chat id"
    );
  }
}

export async function saveDocument({
  id,
  title,
  kind,
  content,
  userId,
}: {
  id: string;
  title: string;
  kind: ArtifactKind;
  content: string;
  userId: string;
}) {
  if (IS_MOCK_MODE) {
    const newDoc: Document = {
      id,
      title,
      kind,
      content,
      userId,
      createdAt: new Date(),
    };
    mockStore.documents.push(newDoc);
    return [newDoc];
  }

  try {
    return await db
      .insert(document)
      .values({
        id,
        title,
        kind,
        content,
        userId,
        createdAt: new Date(),
      })
      .returning();
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to save document");
  }
}

export async function getDocumentsById({ id }: { id: string }) {
  if (IS_MOCK_MODE) {
    return mockStore.documents
      .filter((d) => d.id === id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  try {
    const documents = await db
      .select()
      .from(document)
      .where(eq(document.id, id))
      .orderBy(asc(document.createdAt));

    return documents;
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get documents by id"
    );
  }
}

export async function getDocumentById({ id }: { id: string }) {
  if (IS_MOCK_MODE) {
    return (
      mockStore.documents
        .filter((d) => d.id === id)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ||
      undefined
    );
  }

  try {
    const [selectedDocument] = await db
      .select()
      .from(document)
      .where(eq(document.id, id))
      .orderBy(desc(document.createdAt));

    return selectedDocument;
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get document by id"
    );
  }
}

export async function deleteDocumentsByIdAfterTimestamp({
  id,
  timestamp,
}: {
  id: string;
  timestamp: Date;
}) {
  if (IS_MOCK_MODE) {
    mockStore.suggestions = mockStore.suggestions.filter(
      (s) =>
        !(
          s.documentId === id &&
          s.documentCreatedAt.getTime() > timestamp.getTime()
        )
    );
    const deletedDocs = mockStore.documents.filter(
      (d) => d.id === id && d.createdAt.getTime() > timestamp.getTime()
    );
    mockStore.documents = mockStore.documents.filter(
      (d) => !(d.id === id && d.createdAt.getTime() > timestamp.getTime())
    );
    return deletedDocs;
  }

  try {
    await db
      .delete(suggestion)
      .where(
        and(
          eq(suggestion.documentId, id),
          gt(suggestion.documentCreatedAt, timestamp)
        )
      );

    return await db
      .delete(document)
      .where(and(eq(document.id, id), gt(document.createdAt, timestamp)))
      .returning();
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to delete documents by id after timestamp"
    );
  }
}

export async function saveSuggestions({
  suggestions,
}: {
  suggestions: Suggestion[];
}) {
  if (IS_MOCK_MODE) {
    mockStore.suggestions.push(...suggestions);
    return suggestions;
  }

  try {
    return await db.insert(suggestion).values(suggestions);
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to save suggestions"
    );
  }
}

export async function getSuggestionsByDocumentId({
  documentId,
}: {
  documentId: string;
}) {
  if (IS_MOCK_MODE) {
    return mockStore.suggestions.filter((s) => s.documentId === documentId);
  }

  try {
    return await db
      .select()
      .from(suggestion)
      .where(eq(suggestion.documentId, documentId));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get suggestions by document id"
    );
  }
}

export async function getMessageById({ id }: { id: string }) {
  if (IS_MOCK_MODE) {
    return mockStore.messages.filter((m) => m.id === id);
  }

  try {
    return await db.select().from(message).where(eq(message.id, id));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get message by id"
    );
  }
}

export async function deleteMessagesByChatIdAfterTimestamp({
  chatId,
  timestamp,
}: {
  chatId: string;
  timestamp: Date;
}) {
  if (IS_MOCK_MODE) {
    const messagesToDelete = mockStore.messages.filter(
      (m) => m.chatId === chatId && m.createdAt.getTime() >= timestamp.getTime()
    );
    const messageIds = messagesToDelete.map((m) => m.id);

    if (messageIds.length > 0) {
      mockStore.votes = mockStore.votes.filter(
        (v) => v.chatId !== chatId || !messageIds.includes(v.messageId)
      );
      mockStore.messages = mockStore.messages.filter(
        (m) => m.chatId !== chatId || !messageIds.includes(m.id)
      );
    }
    return;
  }

  try {
    const messagesToDelete = await db
      .select({ id: message.id })
      .from(message)
      .where(
        and(eq(message.chatId, chatId), gte(message.createdAt, timestamp))
      );

    const messageIds = messagesToDelete.map(
      (currentMessage: any) => currentMessage.id
    );

    if (messageIds.length > 0) {
      await db
        .delete(vote)
        .where(
          and(eq(vote.chatId, chatId), inArray(vote.messageId, messageIds))
        );

      return await db
        .delete(message)
        .where(
          and(eq(message.chatId, chatId), inArray(message.id, messageIds))
        );
    }
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to delete messages by chat id after timestamp"
    );
  }
}

export async function updateChatVisibilityById({
  chatId,
  visibility,
}: {
  chatId: string;
  visibility: "private" | "public";
}) {
  if (IS_MOCK_MODE) {
    const chat = mockStore.chats.find((c) => c.id === chatId);
    if (chat) {
      chat.visibility = visibility;
      return [chat];
    }
    return [];
  }

  try {
    return await db.update(chat).set({ visibility }).where(eq(chat.id, chatId));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to update chat visibility by id"
    );
  }
}

export async function updateChatLastContextById({
  chatId,
  context,
}: {
  chatId: string;
  // Store merged server-enriched usage object
  context: AppUsage;
}) {
  if (IS_MOCK_MODE) {
    const chat = mockStore.chats.find((c) => c.id === chatId);
    if (chat) {
        chat.lastContext = context;
    }
    return;
  }

  try {
    return await db
      .update(chat)
      .set({ lastContext: context })
      .where(eq(chat.id, chatId));
  } catch (error) {
    console.warn("Failed to update lastContext for chat", chatId, error);
    return;
  }
}

export async function getMessageCountByUserId({
  id,
  differenceInHours,
}: {
  id: string;
  differenceInHours: number;
}) {
  if (IS_MOCK_MODE) {
     const twentyFourHoursAgo = new Date(
      Date.now() - differenceInHours * 60 * 60 * 1000
    );
    return mockStore.messages.filter(m => {
        const chat = mockStore.chats.find(c => c.id === m.chatId);
        return chat && chat.userId === id && m.createdAt >= twentyFourHoursAgo && m.role === 'user';
    }).length;
  }

  try {
    const twentyFourHoursAgo = new Date(
      Date.now() - differenceInHours * 60 * 60 * 1000
    );

    const [stats] = await db
      .select({ count: count(message.id) })
      .from(message)
      .innerJoin(chat, eq(message.chatId, chat.id))
      .where(
        and(
          eq(chat.userId, id),
          gte(message.createdAt, twentyFourHoursAgo),
          eq(message.role, "user")
        )
      )
      .execute();

    return stats?.count ?? 0;
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get message count by user id"
    );
  }
}

export async function createStreamId({
  streamId,
  chatId,
}: {
  streamId: string;
  chatId: string;
}) {
  if (IS_MOCK_MODE) {
      mockStore.streams.push({ id: streamId, chatId, createdAt: new Date() });
      return;
  }

  try {
    await db
      .insert(stream)
      .values({ id: streamId, chatId, createdAt: new Date() });
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to create stream id"
    );
  }
}

export async function getStreamIdsByChatId({ chatId }: { chatId: string }) {
  if (IS_MOCK_MODE) {
      return mockStore.streams.filter(s => s.chatId === chatId).sort((a,b) => a.createdAt.getTime() - b.createdAt.getTime()).map(s => s.id);
  }

  try {
    const streamIds = await db
      .select({ id: stream.id })
      .from(stream)
      .where(eq(stream.chatId, chatId))
      .orderBy(asc(stream.createdAt))
      .execute();

    return streamIds.map(({ id }: any) => id);
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get stream ids by chat id"
    );
  }
}
