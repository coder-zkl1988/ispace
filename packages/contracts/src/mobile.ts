import { z } from 'zod';

/**
 * 移动端契约。三期实现，一期完整定义——这是规格 D1（全仓骨架）的核心兑现方式：
 * 后续各期只填实现、不改契约。
 *
 * 字段取自设计稿「手机壳 App」第 01–03 屏展示的 app.json，以及技术方案 §5.4。
 */

/**
 * 页面包根部的 app.json：声明内容区的一切。
 *
 * 壳只校验字段格式、不限制取值，读到什么渲染什么（方案 §5.4）。
 * 校验双保险：云端构建期做 Schema 校验（非法配置直接构建失败并回给用户明确报错），
 * 壳运行期二次校验兜底，异常配置回落默认单页布局而非崩溃。
 */
export const appJsonSchema = z.object({
  /**
   * nav  首页是导航页（设计稿 01 屏：4 个 tab 的应用列表）
   * page 首页直接就是某个功能页（设计稿 02 屏：进 App 就是干活的界面）
   */
  home: z.enum(['nav', 'page']).default('nav'),

  tabBar: z
    .object({
      visible: z.boolean().default(true),
      /** 设计稿 03 屏演示了用户可自定高亮色，壳不干预配色。 */
      activeColor: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, 'activeColor 需为 #RRGGBB'),
      items: z
        .array(
          z.object({
            label: z.string().min(1).max(6),
            icon: z.string().min(1),
            route: z.string().min(1),
          }),
        )
        .min(1)
        .max(5),
    })
    /** 缺省即为不显示（设计稿 02 屏：单功能页没有底部 bar）。 */
    .optional(),

  /**
   * 壳入口位置。设计稿第 07 屏明确为「标题栏右上角常驻齿轮，壳保留位，
   * 由壳绘制、永远在页面之上，页面布局需避让该角落」——这与技术方案 §5.5
   * 的「贴边悬浮胶囊」不同，以设计稿为准（规格 §3.4）。
   */
  shellEntry: z
    .object({
      edge: z.enum(['right', 'left']).default('right'),
      collapsed: z.boolean().default(true),
    })
    .default({ edge: 'right', collapsed: true }),
});
export type AppJson = z.infer<typeof appJsonSchema>;

/**
 * expo-updates 的 manifest。协议为公开规范，字段按官方定义，不可自创。
 * 平台自建更新服务器据此返回（方案 §5.3）。
 */
export const updateManifestSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  /**
   * 与壳的 runtimeVersion 协议级匹配。不符则服务端直接不下发——
   * 这是把「版本漂移」从人为约定升级为机制强制的关键（方案 §5）。
   */
  runtimeVersion: z.string().min(1),
  launchAsset: z.object({
    key: z.string(),
    contentType: z.string(),
    url: z.string().url(),
    hash: z.string().optional(),
  }),
  assets: z.array(
    z.object({
      key: z.string(),
      contentType: z.string(),
      url: z.string().url(),
      hash: z.string().optional(),
    }),
  ),
  metadata: z.record(z.string(), z.unknown()).default({}),
  extra: z.record(z.string(), z.unknown()).default({}),
});
export type UpdateManifest = z.infer<typeof updateManifestSchema>;

/** 通道名规则：u-{username}，预览通道 u-{username}-preview（方案 §5.6）。 */
export function channelNameFor(username: string): string {
  return `u-${username}`;
}
export function previewChannelNameFor(username: string): string {
  return `u-${username}-preview`;
}

/**
 * 灰度按设备维度实施：通道请求头附带稳定设备 ID，服务端按放量比例决定
 * 返回新旧 manifest。未被放量的设备完全无感（方案 §5.3）。
 */
export const updateRequestHeadersSchema = z.object({
  'expo-channel-name': z.string().min(1),
  'expo-runtime-version': z.string().min(1),
  /** 稳定设备 ID，灰度分桶依据。 */
  'expo-device-id': z.string().optional(),
  /** 「回到上一个版本」经此标记实现，机制上仍是只改 header。 */
  'x-prefer': z.enum(['previous']).optional(),
});
