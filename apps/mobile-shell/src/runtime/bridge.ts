// SDK 54 起权限方法挂在具名导出的 Camera 对象上，不是模块命名空间上的顶层函数
import { Camera } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Notifications from 'expo-notifications';
import { Linking, Platform } from 'react-native';

/**
 * 原生能力桥（技术方案 §5.5）。
 *
 * ┌─ 「权限集中管理」的实现机制须校正预期 ──────────────────────────────┐
 * │ iOS/Android 均**不允许** App 在自身界面内直接开关系统权限。          │
 * │ 设计稿第 08b 屏那组开关的真实实现是三件套：                          │
 * │   1. 展示各权限当前系统状态                                          │
 * │   2. 一键深链跳转系统设置                                            │
 * │   3. **壳 JS 桥闸门** —— 用户在壳设置中关闭某能力时，桥接层直接      │
 * │      拒绝页面包的对应调用，即使系统权限仍开启                        │
 * │ 产品效果等效于集中管理，但机制是第 3 条在起作用。                     │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 闸门状态存 SecureStore 而非普通存储：页面包与壳同处一个 JS 上下文，
 * 普通存储可被页面包读写，那样闸门就形同虚设。
 */

const GATE_PREFIX = 'ispace.gate.';

export type Capability = 'camera' | 'microphone' | 'photos' | 'notifications';

/** 读闸门状态。默认开启——用户没关过的能力应可用。 */
export async function isCapabilityEnabled(cap: Capability): Promise<boolean> {
  const v = await SecureStore.getItemAsync(`${GATE_PREFIX}${cap}`);
  return v !== 'off';
}

export async function setCapabilityEnabled(cap: Capability, on: boolean): Promise<void> {
  await SecureStore.setItemAsync(`${GATE_PREFIX}${cap}`, on ? 'on' : 'off');
}

export class CapabilityBlockedError extends Error {
  constructor(readonly capability: Capability) {
    super(`能力「${capability}」已在壳设置中关闭`);
    this.name = 'CapabilityBlockedError';
  }
}

/** 闸门检查。所有对外暴露的原生能力入口都必须先过这一关。 */
async function gate(cap: Capability): Promise<void> {
  if (!(await isCapabilityEnabled(cap))) {
    throw new CapabilityBlockedError(cap);
  }
}

// ── 系统权限状态与跳转 ────────────────────────────────────────────────
export interface PermissionState {
  capability: Capability;
  /** 系统层面的授权状态。 */
  granted: boolean;
  /** 是否只授予了受限访问（iOS 相册的「仅选中照片」）。 */
  limited: boolean;
  /** 壳闸门是否开启。两者都为真，能力才真正可用。 */
  gateOpen: boolean;
}

export async function permissionStates(): Promise<PermissionState[]> {
  const [cam, photos, notif] = await Promise.all([
    Camera.getCameraPermissionsAsync(),
    ImagePicker.getMediaLibraryPermissionsAsync(),
    Notifications.getPermissionsAsync(),
  ]);
  const mic = await Camera.getMicrophonePermissionsAsync().catch(() => ({ granted: false }));

  const gates = await Promise.all(
    (['camera', 'microphone', 'photos', 'notifications'] as Capability[]).map(isCapabilityEnabled),
  );

  return [
    { capability: 'camera',        granted: cam.granted,   limited: false, gateOpen: gates[0]! },
    { capability: 'microphone',    granted: mic.granted,   limited: false, gateOpen: gates[1]! },
    { capability: 'photos',        granted: photos.granted, limited: photos.accessPrivileges === 'limited', gateOpen: gates[2]! },
    { capability: 'notifications', granted: notif.granted, limited: false, gateOpen: gates[3]! },
  ];
}

/** 深链到系统设置。这是 App 能做的极限——不能代替用户改系统权限。 */
export async function openSystemSettings(): Promise<void> {
  if (Platform.OS === 'ios') {
    await Linking.openURL('app-settings:');
  } else {
    await Linking.openSettings();
  }
}

// ── 能力入口 ──────────────────────────────────────────────────────────
export async function requestCamera(): Promise<boolean> {
  await gate('camera');
  const r = await Camera.requestCameraPermissionsAsync();
  return r.granted;
}

export async function requestMicrophone(): Promise<boolean> {
  await gate('microphone');
  const r = await Camera.requestMicrophonePermissionsAsync();
  return r.granted;
}

export async function pickImage(): Promise<{ uri: string; base64?: string } | null> {
  await gate('photos');
  const r = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    base64: true,
    quality: 0.7,
  });
  if (r.canceled || !r.assets[0]) return null;
  const a = r.assets[0];
  return a.base64 ? { uri: a.uri, base64: a.base64 } : { uri: a.uri };
}

// ── 安全 ──────────────────────────────────────────────────────────────
/** Face ID / 指纹解锁（设计稿壳设置「安全」段）。 */
export async function unlockWithBiometrics(reason = '回到应用需要验证'): Promise<boolean> {
  const has = await LocalAuthentication.hasHardwareAsync();
  const enrolled = await LocalAuthentication.isEnrolledAsync();
  if (!has || !enrolled) return true; // 设备不支持时不阻断，否则用户直接进不去
  const r = await LocalAuthentication.authenticateAsync({ promptMessage: reason });
  return r.success;
}

// ── 会话存储 ──────────────────────────────────────────────────────────
/**
 * 平台会话 token。必须存 SecureStore：页面包与壳同处一个 JS 上下文，
 * 存普通存储等于把 token 交给用户代码。
 */
const TOKEN_KEY = 'ispace.session';

export const session = {
  get: () => SecureStore.getItemAsync(TOKEN_KEY),
  set: (t: string) => SecureStore.setItemAsync(TOKEN_KEY, t),
  clear: () => SecureStore.deleteItemAsync(TOKEN_KEY),
};

/**
 * 稳定设备 ID，用于灰度分桶。
 *
 * 存 SecureStore 而非每次生成：分桶必须稳定，否则同一台设备会时而被放量
 * 时而不被放量，表现为更新提示忽隐忽现。
 */
const DEVICE_KEY = 'ispace.deviceId';

export async function deviceId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DEVICE_KEY);
  if (existing) return existing;
  const id = `d-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  await SecureStore.setItemAsync(DEVICE_KEY, id);
  return id;
}

/**
 * 「首页默认打开哪个页面」。
 *
 * 存在设备上而不是账号上：同一个人在工位电脑旁用手机看排班、回到家想看
 * 别的，这是随手换的偏好，不该同步成一份全局设置去覆盖另一台设备。
 * 值是 LaunchItem 的 key，认不出来（页面删了、改名了）就当没设过。
 */
const HOME_KEY = 'ispace.home.default';

export async function getDefaultHome(): Promise<string | null> {
  try { return await SecureStore.getItemAsync(HOME_KEY); } catch { return null; }
}

export async function setDefaultHome(key: string | null): Promise<void> {
  try {
    if (key) await SecureStore.setItemAsync(HOME_KEY, key);
    else await SecureStore.deleteItemAsync(HOME_KEY);
  } catch { /* 存不下就下次再问，不该让设置这个动作报错 */ }
}
