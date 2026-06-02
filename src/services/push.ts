// Expo Push — envoi de notifications push aux devices iOS/Android via Expo's push API.
// Best-effort : on log les erreurs mais on ne fait jamais planter une requête à cause d'un push raté.
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export type PushPayload = {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  badge?: number;
};

type ExpoMessage = {
  to: string;
  sound: 'default';
  title: string;
  body: string;
  data?: Record<string, unknown>;
  badge?: number;
  channelId?: string;
};

export async function sendExpoPush(payload: PushPayload): Promise<void> {
  const tokens = await prisma.expoPushToken.findMany({
    where: { userId: payload.userId },
    select: { token: true },
  });

  if (tokens.length === 0) {
    logger.debug({ userId: payload.userId }, 'No push tokens registered, skipping push');
    return;
  }

  const messages: ExpoMessage[] = tokens.map((t) => ({
    to: t.token,
    sound: 'default',
    title: payload.title,
    body: payload.body,
    data: payload.data,
    badge: payload.badge,
    channelId: 'default',
  }));

  try {
    const { data } = await axios.post(EXPO_PUSH_URL, messages, {
      timeout: 15000,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
    logger.info({ userId: payload.userId, count: messages.length, response: data }, 'Expo push sent');
  } catch (e) {
    logger.warn({ err: e, userId: payload.userId }, 'Expo push failed');
  }
}

// Register a device token for the current user. Idempotent : if the token already exists,
// updates lastUsedAt and links it to the user (in case of device transfer).
export async function registerPushToken(userId: string, token: string, platform: 'ios' | 'android', deviceName?: string): Promise<void> {
  await prisma.expoPushToken.upsert({
    where: { token },
    update: { userId, platform, deviceName, lastUsedAt: new Date() },
    create: { userId, token, platform, deviceName },
  });
}

export async function unregisterPushToken(token: string): Promise<void> {
  await prisma.expoPushToken.deleteMany({ where: { token } });
}
