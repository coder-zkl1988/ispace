import { describe, expect, it } from 'vitest';
import { CONNECTOR_CATALOG } from '../connectors.js';

describe('连接器目录', () => {
  it('每个需要自备凭据的条目都有 HTTPS 官方申请入口', () => {
    const protectedEntries = CONNECTOR_CATALOG.filter((entry) => entry.authKind !== 'none');

    expect(protectedEntries.length).toBeGreaterThan(0);
    for (const entry of protectedEntries) {
      expect(entry.applyUrl, entry.name).toMatch(/^https:\/\//);
    }
  });
});
