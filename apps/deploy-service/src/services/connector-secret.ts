import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * 连接器凭据的加密存储。
 *
 * 用 AES-256-GCM 而不是只做个 base64：库的备份、只读副本、误导出的 CSV
 * 都会带着这张表跑，明文存等于把所有人的第三方 key 交给任何拿到一份备份的人。
 * GCM 而不是 CBC，是因为它自带完整性校验——密文被改过会解密失败而不是
 * 解出一段垃圾再拿去当凭据用。
 *
 * 密钥来自环境变量，只存在服务器的 ~/.ispace/env（600）里：
 *
 *     ISPACE_CONNECTOR_KEY=$(openssl rand -hex 32)
 *
 * 没配置时**不回落到明文**，而是拒绝创建带凭据的连接器。回落明文是那种
 * "开发时能跑、上线后没人发现"的错误：功能表现完全正常，只有库里
 * 躺着一堆裸密钥。免凭据的连接器不受影响，照常能用。
 */

const MAGIC = 'v1';

export class ConnectorKeyMissing extends Error {
  constructor() {
    super(
      '平台还没配置连接器加密密钥，无法保管凭据。'
      + '请管理员在服务器执行：'
      + "printf 'ISPACE_CONNECTOR_KEY=%s\\n' \"$(openssl rand -hex 32)\" >> ~/.ispace/env"
      + ' 然后重新部署 deploy-service。免凭据的连接器不受影响。',
    );
  }
}

function key(): Buffer {
  const raw = process.env.ISPACE_CONNECTOR_KEY;
  if (!raw) throw new ConnectorKeyMissing();
  const buf = Buffer.from(raw.trim(), 'hex');
  // 32 字节是 AES-256 的硬要求。给出确切位数，否则用户只会看到一句
  // "invalid key length" 而不知道该生成多长的。
  if (buf.length !== 32) {
    throw new Error(
      `ISPACE_CONNECTOR_KEY 必须是 64 个十六进制字符（32 字节），当前解析出 ${buf.length} 字节。`
      + ' 用 openssl rand -hex 32 生成。',
    );
  }
  return buf;
}

/** 平台有没有能力保管凭据。用于界面提前给出提示，而不是等用户填完才报错。 */
export function secretStorageReady(): boolean {
  try { key(); return true; } catch { return false; }
}

/** 密文布局：v1:<iv hex>:<authTag hex>:<密文 hex>，自描述，便于将来换算法。 */
export function encryptSecret(plain: string): Buffer {
  const iv = randomBytes(12); // GCM 的标准 nonce 长度
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.from(
    `${MAGIC}:${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${enc.toString('hex')}`,
    'utf8',
  );
}

export function decryptSecret(stored: Buffer): string {
  const parts = stored.toString('utf8').split(':');
  const [magic, ivHex, tagHex, dataHex] = parts;
  if (magic !== MAGIC || !ivHex || !tagHex || !dataHex) {
    throw new Error('连接器凭据的密文格式不认识，可能是库被改过或加密密钥换过了');
  }
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivHex, 'hex'));
  d.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([d.update(Buffer.from(dataHex, 'hex')), d.final()]).toString('utf8');
}
