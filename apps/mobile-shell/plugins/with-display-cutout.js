/**
 * 让内容画进刘海 / 挖孔区。
 *
 * H5 页面在壳里是全出血的（见 src/shell/WebPage.tsx），但安卓默认
 * `windowLayoutInDisplayCutoutMode=default` 会在挖孔那一侧留一条letterbox
 * 黑边／底色带——实测顶部还剩约 35px 的浅色条，页面照片铺不上去。
 * 设成 shortEdges 之后，短边方向的挖孔区也交给应用绘制，条就没了。
 *
 * 安全区不受影响：react-native-safe-area-context 读的是 WindowInsets，
 * 挖孔会计进 insets.top，启动器那些用 insets 让位的屏照常正确。
 *
 * 写成 config plugin 而不是直接改 android/：那个目录是 CNG 生成的，
 * 手改的东西下次 expo prebuild 就没了（Podfile 那次已经踩过）。
 */
const { withAndroidStyles } = require('expo/config-plugins');

const ATTR = 'android:windowLayoutInDisplayCutoutMode';

module.exports = function withDisplayCutout(config) {
  return withAndroidStyles(config, (cfg) => {
    const styles = cfg.modResults.resources.style ?? [];
    const app = styles.find((s) => s.$?.name === 'AppTheme');
    if (!app) return cfg;

    app.item = (app.item ?? []).filter((i) => i.$?.name !== ATTR);
    app.item.push({ $: { name: ATTR }, _: 'shortEdges' });
    return cfg;
  });
};
