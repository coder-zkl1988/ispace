import { describe, expect, it } from 'vitest';
import { usernameSchema, isReservedPath } from '@ispace/contracts';
import { feishuUsername } from '../services/feishu-account.js';

describe('Feishu stable space paths', () => {
  it.each([undefined, '中文', 'admin', 'a_very_long_username_not_a_valid_path', 'alice'])('handles identifier %s', preferredUsername => {
    const input = { sub: 'feishu|tenant|employee', name: '员工', preferredUsername, raw: {} };
    const path = feishuUsername(input);
    expect(usernameSchema.safeParse(path).success).toBe(true);
    expect(isReservedPath(path)).toBe(false);
    expect(feishuUsername(input)).toBe(path);
    expect(feishuUsername({ ...input, sub: 'feishu|tenant|other' })).not.toBe(path);
  });
});
