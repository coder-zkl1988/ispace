import { registerRootComponent } from 'expo';

import App from './App';

/**
 * 原生壳的入口。package.json 的 main 指向这里。
 *
 * registerRootComponent 等价于 AppRegistry.registerComponent('main', () => App)，
 * 但额外处理了 Expo 在开发构建下需要的环境设置。
 *
 * 这个文件必须存在且必须是 .js —— Gradle 在配置阶段就要解析 main 字段拿到
 * 入口路径（app/build.gradle 的 react.entryFile），那时还没有 TS 编译。
 */
registerRootComponent(App);
