-- 「知道链接的任何人」：link 档改为凭私密令牌访问，不再只认公司网段。
-- 令牌只在 visibility = 'link' 时存在；切走即清空，重新开启会换一个新的，
-- 旧链接与旧访问 Cookie 一起失效。
ALTER TABLE ispace.apps ADD COLUMN link_token text;
ALTER TABLE ispace.backends ADD COLUMN link_token text;

-- 已经是 link 的资源补一个令牌，原来的裸地址从此需要带令牌才能匿名打开。
-- 用两段 gen_random_uuid（PG13 起内置，不依赖 pgcrypto 装在哪个 schema），约 244 位随机。
UPDATE ispace.apps SET link_token = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') WHERE visibility = 'link';
UPDATE ispace.backends SET link_token = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') WHERE visibility = 'link';
