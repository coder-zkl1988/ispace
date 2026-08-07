-- 分类从 marketplace_listings 移到 apps。
--
-- 上一版（0012）把 category 放 listings，理由是「在市场里怎么摆」。但改成由
-- 做页面的 AI 在 deploy 时决定分类后，它就成了「这个页面是什么」——页面自己的
-- 属性，和 source_prompt 一样。放 apps 才对，且页面没上架也能带着分类。
--
-- 顺带：分类不再是固定枚举，AI 可自造（见 contracts 的 marketplaceCategorySchema）。
ALTER TABLE ispace.apps ADD COLUMN IF NOT EXISTS category text;

-- 迁移已有的有意义分类（跳过占位的「其他」）。
UPDATE ispace.apps a
   SET category = m.category
  FROM ispace.marketplace_listings m
 WHERE m.app_id = a.id AND m.category IS NOT NULL AND m.category <> '其他';

-- listings 上那列作废。新代码只读 apps.category。0012 是本会话刚加的、无真实
-- 数据依赖，直接删掉，免得两处 category 让人迷惑。
ALTER TABLE ispace.marketplace_listings DROP COLUMN IF EXISTS category;
