import { describe, expect, it } from 'vitest';
import { createIntranetPolicy } from '../services/intranet.js';

describe('intranet source validation', () => {
  const check = createIntranetPolicy('192.0.2.0/24,2001:db8:1234::/48', '10.10.0.1/32,10.10.0.2/32');
  it('denies every source when company CIDRs are absent', () => {
    expect(createIntranetPolicy('')('192.0.2.12')).toBe(false);
  });
  it('accepts direct company sources and IPv4 mapped addresses', () => {
    expect(check('192.0.2.12')).toBe(true);
    expect(check('::ffff:192.0.2.12')).toBe(true);
    expect(check('2001:db8:1234::1')).toBe(true);
    expect(check('2001:db8:9999::1')).toBe(false);
  });
  it('ignores spoofed XFF from untrusted public clients', () => {
    expect(check('203.0.113.12', '192.0.2.12')).toBe(false);
  });
  it('walks both Traefik and Caddy, but stops at the real untrusted client', () => {
    expect(check('10.10.0.2', '192.0.2.12, 10.10.0.1')).toBe(true);
    expect(check('10.10.0.2', '192.0.2.12, 203.0.113.12, 10.10.0.1')).toBe(false);
    expect(check('10.10.0.1', '192.0.2.12')).toBe(true);
  });
  it.each([undefined, '', 'unknown', '192.0.2.12:443', '10.10.0.1', ['192.0.2.12']])('rejects missing/ambiguous proxy origins %j', value => {
    expect(check('10.10.0.2', value)).toBe(false);
  });
  it.each(['0.0.0.0/99', 'invalid', '::/129', '192.0.2.0/', '192.0.2.0/24/1', '0.0.0.0/0', '::/0', ', ,'])('rejects invalid configuration %s', cidr => {
    expect(() => createIntranetPolicy(cidr)).toThrow('CIDR');
  });
});
