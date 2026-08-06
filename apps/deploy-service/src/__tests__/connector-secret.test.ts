import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConnectorKeyMissing, decryptSecret, encryptSecret, secretStorageReady,
} from '../services/connector-secret.js';

const KEY = 'a'.repeat(64); // 32 字节的十六进制表示

describe('连接器凭据加解密', () => {
  const saved = process.env.ISPACE_CONNECTOR_KEY;
  beforeEach(() => { process.env.ISPACE_CONNECTOR_KEY = KEY; });
  afterEach(() => {
    if (saved === undefined) delete process.env.ISPACE_CONNECTOR_KEY;
    else process.env.ISPACE_CONNECTOR_KEY = saved;
  });

  it('原样转一圈回来', () => {
    for (const s of ['sk-abc123', '中文凭据也要能存', 'a'.repeat(4000), '带:冒号:的值']) {
      expect(decryptSecret(encryptSecret(s))).toBe(s);
    }
  });

  it('每次加密的密文都不同——同一个 key 被两个人用了同一个值时不能看出来', () => {
    expect(encryptSecret('same').toString()).not.toBe(encryptSecret('same').toString());
  });

  it('密文被改过就解不开，而不是解出一段垃圾当凭据用', () => {
    const enc = encryptSecret('secret-value').toString('utf8');
    const parts = enc.split(':');
    // 翻转密文最后一个十六进制字符
    const data = parts[3]!;
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${data.slice(0, -1)}${data.at(-1) === '0' ? '1' : '0'}`;
    expect(() => decryptSecret(Buffer.from(tampered, 'utf8'))).toThrow();
  });

  it('换了密钥就解不开旧密文', () => {
    const enc = encryptSecret('secret-value');
    process.env.ISPACE_CONNECTOR_KEY = 'b'.repeat(64);
    expect(() => decryptSecret(enc)).toThrow();
  });

  it('没配密钥时明确拒绝，绝不回落成明文存储', () => {
    delete process.env.ISPACE_CONNECTOR_KEY;
    expect(secretStorageReady()).toBe(false);
    expect(() => encryptSecret('x')).toThrow(ConnectorKeyMissing);
  });

  it('密钥长度不对时说清楚该生成多长的', () => {
    process.env.ISPACE_CONNECTOR_KEY = 'abcd';
    expect(() => encryptSecret('x')).toThrow(/openssl rand -hex 32/);
  });

  it('格式不认识的密文报错说人话', () => {
    expect(() => decryptSecret(Buffer.from('随便一段不是密文的东西', 'utf8')))
      .toThrow(/格式不认识/);
  });
});
