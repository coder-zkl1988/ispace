# iOS 构建

安卓那边 APK 随时能出（`android/ && ./gradlew assembleRelease`），iOS 卡在
**签名**：没有 Apple 开发者账号与证书，构建产物装不上任何真机。这份文档
把「不需要证书就能做的」与「拿到证书后要做的」分开写清。

## 现状（2026-08-05）

| 事项 | 状态 |
|---|---|
| CNG 工程（`expo prebuild --platform ios`） | ✅ 可重复生成，`ios/` 不进 git |
| ATS 明文 HTTP 例外 | ✅ `NSAllowsArbitraryLoads`（平台还在 HTTP 上，与安卓 `usesCleartextTraffic` 同一回事；上 HTTPS 后**两处都要收掉**，见 `apps/mobile-shell/CLEARTEXT.md`） |
| 相机/麦克风/相册/FaceID 用途描述 | ✅ 都在 `app.json` 的 `infoPlist` 里，缺一条上架审核就拒 |
| 模拟器构建（不需要签名） | ✅ 本机 Xcode 27 验证通过 |
| 真机/分发构建 | ❌ 等 Apple 开发者账号 |

## 不需要证书：模拟器构建

用来验证 iOS 侧编译没坏。CI 或本机跑：

```bash
cd apps/mobile-shell
npx expo prebuild --platform ios --no-install
cd ios && LANG=en_US.UTF-8 pod install
xcodebuild -workspace ispace.xcworkspace -scheme ispace \
  -configuration Release -sdk iphonesimulator \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO build
```

产物在 `ios/build/Build/Products/Release-iphonesimulator/iSpace.app`，
`xcrun simctl install booted <path>` 可装进模拟器手测。

### 本机踩过的两个坑（2026-08-05，Xcode 27 beta）

1. **pod install 直接崩**：`Unicode Normalization not appropriate for
   ASCII-8BIT`。系统 Ruby 2.6 的 CocoaPods 在非 UTF-8 终端下必炸——
   命令前面加 `LANG=en_US.UTF-8` 即可。
2. **Xcode 27 拒绝 15.0 以下的部署目标**，而 RNSVG、ReachabilitySwift 等
   老 pod 声明的是 12.x。修法是 Podfile 的 post_install 里把所有 pod 的
   `IPHONEOS_DEPLOYMENT_TARGET` 抬到 15.1。⚠️ `ios/` 是 CNG 生成的，
   直接改 Podfile 会在下次 `expo prebuild` 时被冲掉——应用自身的
   deploymentTarget 已持久在 app.json 的 expo-build-properties 里，
   但 pod 的抬底那段每次重新 prebuild 后要重打（或者等升级到不需要
   这个补丁的 Expo 版本）。补丁内容见 git 历史或下方：

   ```ruby
   installer.pods_project.targets.each do |t|
     t.build_configurations.each do |c|
       v = c.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
       c.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.1' if v && v.to_f < 15.1
     end
   end
   ```

## 需要证书：真机与分发

### 要向公司 Apple 账号管理员要的东西

1. **Apple Developer Program 账号**（企业内部分发要 Enterprise Program，
   或普通账号走 Ad Hoc / TestFlight）
2. 把构建这台机器的 Apple ID 加进团队，角色至少 **Developer**
3. 你的 Bundle ID（`ISPACE_APP_ID`，默认 `com.example.ispace`）在团队里注册

### 拿到之后

```bash
# Xcode 登录账号：Settings → Accounts → 加 Apple ID → Download Manual Profiles
cd apps/mobile-shell/ios
xcodebuild -workspace ispace.xcworkspace -scheme ispace \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath build/ispace.xcarchive archive \
  DEVELOPMENT_TEAM=<TeamID> -allowProvisioningUpdates
xcodebuild -exportArchive -archivePath build/ispace.xcarchive \
  -exportPath build/export -exportOptionsPlist ExportOptions.plist
```

`ExportOptions.plist` 按分发方式选 `method`：
`ad-hoc`（指定设备）/ `enterprise`（企业分发）/ `app-store`（TestFlight）。

### 分发方式怎么选

- **同事都是公司设备、数量少** → Ad Hoc：把设备 UDID 登记进
  provisioning profile，IPA 直接发；改设备名单要重新出包。
- **人多、设备不固定** → TestFlight：走 App Store Connect，审核宽松、
  安装体验最好；需要普通开发者账号（$99/年）。
- **Enterprise（$299/年）** 审批严，新申请很难批，除非公司已有别用。

## 已知差异（相对安卓）

- 深链 scheme `ispace://` 在 iOS 由 `CFBundleURLTypes` 承载，prebuild 会从
  `app.json` 的 `scheme` 自动生成，不用手配。
- 更新通道机制（expo-updates 改请求头）两端同一套代码，iOS 不需要单独适配。
- 安卓那套「厂商 ROM 冻结后台定时器」的坑（HyperHold）iOS 没有，
  但 iOS 的后台网络另有节流——登录轮询已经带 AppState 唤醒，两端通用。
