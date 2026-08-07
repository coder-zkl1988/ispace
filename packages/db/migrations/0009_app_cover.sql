-- 页面卡片的封面图。
--
-- 存的是卡片 <img src> 直接能用的东西：要么是产物里 og:image 的绝对 URL，
-- 要么是站内相对路径 /{user}/{slug}/cover.png。不存二进制、不由平台托管图片
-- ——图片本就在用户产物里，平台只记"用哪张"。
--
-- 可空：绝大多数已有页面没有声明封面，卡片回落到字母块（与今天一致）。
ALTER TABLE ispace.apps ADD COLUMN IF NOT EXISTS cover_path text;
