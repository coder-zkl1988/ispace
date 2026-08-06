import { describe, expect, it } from 'vitest';
import { withCurrentOrigin } from '../manifest-origin.js';

const manifest = (origin: string) => ({
  id: 'abc',
  launchAsset: { key: 'index.hbc', url: `${origin}/updates/assets/zkl/37/index.hbc` },
  assets: [{ key: 'a.png', url: `${origin}/updates/assets/zkl/37/a.png` }],
});

describe('withCurrentOrigin', () => {
  it('把发布时刻写死的 http 地址换成当前的 https', () => {
    const out = withCurrentOrigin(
      manifest('http://workspace.example.com'),
      'https://workspace.example.com',
    ) as ReturnType<typeof manifest>;
    expect(out.launchAsset.url).toBe('https://workspace.example.com/updates/assets/zkl/37/index.hbc');
    expect(out.assets[0]?.url).toBe('https://workspace.example.com/updates/assets/zkl/37/a.png');
  });

  it('换域名同样跟得上', () => {
    const out = withCurrentOrigin(
      manifest('https://old.example.com'),
      'https://new.example.com',
    ) as ReturnType<typeof manifest>;
    expect(out.launchAsset.url).toBe('https://new.example.com/updates/assets/zkl/37/index.hbc');
  });

  it('末尾斜杠不会写出双斜杠', () => {
    const out = withCurrentOrigin(
      manifest('http://a.example.com'),
      'https://b.example.com/',
    ) as ReturnType<typeof manifest>;
    expect(out.launchAsset.url).toBe('https://b.example.com/updates/assets/zkl/37/index.hbc');
  });

  it('不碰不是本平台的地址', () => {
    const m = { assets: [{ url: 'https://cdn.other.com/img/a.png' }] };
    expect(withCurrentOrigin(m, 'https://workspace.example.com')).toEqual(m);
  });

  it('地址已经对了就原样返回同一个对象，不做无谓的序列化', () => {
    const m = manifest('https://workspace.example.com');
    expect(withCurrentOrigin(m, 'https://workspace.example.com')).toBe(m);
  });

  it('base 里的 $ 不会被当成分组引用', () => {
    const out = withCurrentOrigin(
      manifest('http://a.example.com'),
      'https://b$1.example.com',
    ) as ReturnType<typeof manifest>;
    expect(out.launchAsset.url).toBe('https://b$1.example.com/updates/assets/zkl/37/index.hbc');
  });

  it('null 原样返回', () => {
    expect(withCurrentOrigin(null, 'https://x.example.com')).toBeNull();
  });
});
