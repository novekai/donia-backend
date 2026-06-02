// Cloudflare R2 (S3-compatible) — upload helper for media (avatars, anonymes visuals).
// R2 endpoint: https://<accountId>.r2.cloudflarestorage.com
// Public URL: served via R2 public bucket OR a custom domain (env R2_PUBLIC_URL).
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { logger } from '../lib/logger';

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new Error('R2 not configured (set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)');
  }
  if (!_client) {
    _client = new S3Client({
      region: 'auto',
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return _client;
}

function publicUrlFor(key: string): string {
  if (env.R2_PUBLIC_URL) {
    return `${env.R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`;
  }
  // Fallback : R2 public dev URL (must be enabled on the bucket)
  return `https://pub-${env.R2_ACCOUNT_ID}.r2.dev/${key}`;
}

export async function uploadBuffer(
  buffer: Buffer,
  key: string,
  contentType: string,
  cacheControl = 'public, max-age=31536000, immutable',
): Promise<string> {
  const client = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: cacheControl,
    }),
  );
  return publicUrlFor(key);
}

export async function deleteObject(key: string): Promise<void> {
  try {
    const client = getClient();
    await client.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
  } catch (e) {
    logger.warn({ err: e, key }, 'R2 delete failed (non-fatal)');
  }
}

// Upload a user avatar — resizes to 512px square WebP, returns the public URL.
// We keep a single size for now (512px); the app/web can downscale as needed.
export async function uploadAvatar(userId: string, input: Buffer): Promise<string> {
  const optimized = await sharp(input)
    .rotate() // auto-rotate based on EXIF
    .resize(512, 512, { fit: 'cover', position: 'centre' })
    .webp({ quality: 82 })
    .toBuffer();

  const key = `avatars/${userId}/${randomUUID()}.webp`;
  return uploadBuffer(optimized, key, 'image/webp');
}
