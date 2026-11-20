import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { tenantKeys } from '../db/schema/index.js';
import type { KeyProvider } from '../db/schema/values.js';
import type { TenantTx } from '../db/tenant.js';
import { audit } from './audit.js';

/**
 * Field encryption with each tenant's own key (ADR 0010,
 * docs/decisions/field-encryption.md). Envelope encryption: every tenant has
 * one data key, stored only sealed by the key provider; fields are sealed
 * with the data key using AES-256-GCM.
 *
 * A sealed value names the column it belongs to (its purpose), the tenant and
 * the key, all bound into the authentication tag (ENC1), so a value copied to
 * another tenant, another column or another key fails to open instead of
 * opening as the wrong thing.
 *
 * Opening a value writes no audit entry: the caller's read of the record it
 * belongs to does (ADR 0008).
 */

/** `<schema>.<table>.<column>`, e.g. `clinical.patients.medicare_number`. */
export type FieldPurpose = `${string}.${string}.${string}`;

const FORMAT = 'enc1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** Seals and opens data keys. `local` uses FIELD_ENCRYPTION_KEY; the KMS provider comes before the first patient (ENC3). */
interface KeyProviderImpl {
  readonly name: KeyProvider;
  seal(dataKey: Buffer, tenantId: string): string;
  open(sealed: string, tenantId: string): Buffer;
}

function gcmSeal(key: Buffer, plain: Buffer, aad: string): { iv: Buffer; body: Buffer; tag: Buffer } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { iv, body, tag: cipher.getAuthTag() };
}

function gcmOpen(key: Buffer, parts: { iv: Buffer; body: Buffer; tag: Buffer }, aad: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, parts.iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(parts.tag);
  return Buffer.concat([decipher.update(parts.body), decipher.final()]);
}

const b64 = (buffer: Buffer): string => buffer.toString('base64url');
const unb64 = (text: string): Buffer => Buffer.from(text, 'base64url');

export class FieldCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldCryptoError';
  }
}

/** The key-encryption key from FIELD_ENCRYPTION_KEY: base64 of 32 bytes. Checked at boot (src/config/env.ts). */
function localProvider(): KeyProviderImpl {
  const kek = Buffer.from(env.FIELD_ENCRYPTION_KEY ?? '', 'base64');
  if (kek.length !== KEY_BYTES) throw new FieldCryptoError('FIELD_ENCRYPTION_KEY must be base64 of 32 bytes');
  return {
    name: 'local',
    seal(dataKey, tenantId) {
      const { iv, body, tag } = gcmSeal(kek, dataKey, `tenant-key|${tenantId}`);
      return `local1.${b64(iv)}.${b64(body)}.${b64(tag)}`;
    },
    open(sealed, tenantId) {
      const [format, iv, body, tag] = sealed.split('.');
      if (format !== 'local1' || !iv || !body || !tag) throw new FieldCryptoError('This tenant key was sealed by another provider');
      return gcmOpen(kek, { iv: unb64(iv), body: unb64(body), tag: unb64(tag) }, `tenant-key|${tenantId}`);
    },
  };
}

let provider: KeyProviderImpl | null = null;
function keyProvider(): KeyProviderImpl {
  provider ??= localProvider();
  return provider;
}

/**
 * Opened data keys, by tenant and key id, so a busy tenant doesn't open its
 * key on every field. Filled only after the key row was read inside that
 * tenant's transaction, so row-level security has already said it is theirs.
 */
const openedKeys = new Map<string, Buffer>();
const MAX_OPENED_KEYS = 1000;

function remember(cacheKey: string, key: Buffer): void {
  if (openedKeys.size >= MAX_OPENED_KEYS) openedKeys.delete(openedKeys.keys().next().value as string);
  openedKeys.set(cacheKey, key);
}

interface DataKey {
  id: string;
  key: Buffer;
}

async function keyById(tx: TenantTx, keyId: string): Promise<DataKey> {
  const { tenantId } = tx.context;
  const cacheKey = `${tenantId}:${keyId}`;
  const cached = openedKeys.get(cacheKey);
  if (cached) return { id: keyId, key: cached };
  const [row] = await tx.db.select({ id: tenantKeys.id, wrappedKey: tenantKeys.wrappedKey }).from(tenantKeys).where(eq(tenantKeys.id, keyId));
  if (!row) throw new FieldCryptoError("This value was sealed with a key this tenant doesn't have");
  const key = keyProvider().open(row.wrappedKey, tenantId);
  remember(cacheKey, key);
  return { id: row.id, key };
}

/**
 * The tenant's current data key, made on first use (ENC2). Two first uses at
 * once both insert; the unique index keeps one and the other reads it back.
 */
async function currentKey(tx: TenantTx): Promise<DataKey> {
  const { tenantId } = tx.context;
  const [existing] = await tx.db.select({ id: tenantKeys.id }).from(tenantKeys).where(eq(tenantKeys.tenantId, tenantId));
  if (existing) return keyById(tx, existing.id);

  const key = randomBytes(KEY_BYTES);
  const [created] = await tx.db
    .insert(tenantKeys)
    .values({ tenantId, provider: keyProvider().name, wrappedKey: keyProvider().seal(key, tenantId) })
    .onConflictDoNothing()
    .returning({ id: tenantKeys.id });
  if (!created) {
    const [winner] = await tx.db.select({ id: tenantKeys.id }).from(tenantKeys).where(eq(tenantKeys.tenantId, tenantId));
    if (!winner) throw new FieldCryptoError('The tenant key could not be made');
    return keyById(tx, winner.id);
  }
  await audit(tx, {
    action: 'tenant_key.created',
    zone: 'platform',
    recordTable: 'platform.tenant_keys',
    recordId: created.id,
    details: { provider: keyProvider().name },
  });
  remember(`${tenantId}:${created.id}`, key);
  return { id: created.id, key };
}

const aadFor = (tenantId: string, purpose: FieldPurpose, keyId: string): string => `${FORMAT}|${tenantId}|${purpose}|${keyId}`;

/** Seal one value for one column, with the tenant's key. The result is text safe to store in a `text` column. */
export async function encryptField(tx: TenantTx, purpose: FieldPurpose, plain: string): Promise<string> {
  const { id, key } = await currentKey(tx);
  const { iv, body, tag } = gcmSeal(key, Buffer.from(plain, 'utf8'), aadFor(tx.context.tenantId, purpose, id));
  return `${FORMAT}.${id}.${b64(iv)}.${b64(body)}.${b64(tag)}`;
}

/** Open a value sealed by encryptField for the same tenant and column. Throws FieldCryptoError on anything else. */
export async function decryptField(tx: TenantTx, purpose: FieldPurpose, sealed: string): Promise<string> {
  const [format, keyId, iv, body, tag] = sealed.split('.');
  if (format !== FORMAT || !keyId || !iv || !body || !tag) throw new FieldCryptoError('This is not a sealed value');
  const { key } = await keyById(tx, keyId);
  try {
    return gcmOpen(key, { iv: unb64(iv), body: unb64(body), tag: unb64(tag) }, aadFor(tx.context.tenantId, purpose, keyId)).toString('utf8');
  } catch {
    throw new FieldCryptoError('This value does not belong to this tenant and column, or it was changed');
  }
}

/** Seal a value that may be absent. */
export async function encryptOptional(tx: TenantTx, purpose: FieldPurpose, plain: string | null | undefined): Promise<string | null> {
  return plain === null || plain === undefined ? null : encryptField(tx, purpose, plain);
}

/** Open a value that may be absent. */
export async function decryptOptional(tx: TenantTx, purpose: FieldPurpose, sealed: string | null): Promise<string | null> {
  return sealed === null ? null : decryptField(tx, purpose, sealed);
}
