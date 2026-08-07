-- 创意市场分类。页面越来越多，扁平一片网格找不到东西——加分类让侧边栏能聚合。
--
-- 放 marketplace_listings 而不是 apps：分类是「在市场里怎么摆」的属性，不属于
-- 页面本身。同一个页面下架再上架，重新归类是正常的。
-- 默认「其他」：存量 listing 与没归类的新 listing 都先落这一格，作者可改。
ALTER TABLE ispace.marketplace_listings
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT '其他';
