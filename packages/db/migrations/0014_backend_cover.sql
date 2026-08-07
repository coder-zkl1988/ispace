-- 后端应用的封面截图。
--
-- 页面的封面存成 release 目录里的文件、cover_path 指过去；后端没有静态目录，
-- 所以直接把截图字节存库（几十~几百 KB，后端数量不多，可接受），经
-- GET /deploy/api/backends/:id/cover 提供。露出到空间时后台截一张它的首屏。
ALTER TABLE ispace.backends
  ADD COLUMN IF NOT EXISTS cover bytea,
  ADD COLUMN IF NOT EXISTS cover_updated_at timestamptz;
