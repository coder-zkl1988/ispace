-- 「做同款」：页面保留它是被什么提示词做出来的。
--
-- 创意市场上看到一个好页面，最有用的信息不是它的截图，而是**做它的那句话**。
-- 用户拿走提示词，改几个字发给自己的 AI，就得到一个属于自己的版本——
-- 这比"安装别人的页面"更接近这个平台想做的事。
--
-- 存在 apps 而不是 marketplace_listings：提示词属于这个页面本身，
-- 上架只是决定它给不给别人看。下架再上架不该丢掉它。
ALTER TABLE ispace.apps
  ADD COLUMN IF NOT EXISTS source_prompt text;

COMMENT ON COLUMN ispace.apps.source_prompt IS
  '做出这个页面的提示词，由发布方随发布带上。上架到创意市场后对所有人可见——不要放进任何内部信息。';
