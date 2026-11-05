import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, AppState, Dimensions, FlatList, Image, Modal, Pressable, ScrollView, Share,
  StyleSheet, Text, TextInput, View, type ViewToken,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { exploreBucket, type Comment } from '@ispace/contracts';
import { absCover, api, type Listing } from '../api';
import { API_BASE } from '../config';
import { useVoiceInput } from '../runtime/voice';
import { Icon } from './Icon';
import { VoicePanel } from './VoicePanel';

/**
 * 探索（移动端 v2 稿 · 03 推荐 / 04 做同款）。
 *
 * ┌─ 它替掉了什么 ────────────────────────────────────────────────────┐
 * │ 旧的「创意集市」是一列卡片：封面缩略图 + 名字 + 作者 + 一颗「添加」。│
 * │ 新稿把它改成整屏一个——一次只看一个页面，上下滑着刷。手机上那一列    │
 * │ 卡片的问题是：每张都小得看不出页面长什么样，于是"装不装"全靠名字    │
 * │ 猜。整屏铺开之后，封面才真的起到了封面的作用。                      │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 「自动播放」开着时（设置里那一行，默认开），刷到的那一个页面直接跑起来：
 * 换一张试玩令牌（和电脑端「为你推荐」同一条路），在卡片里装一个只看不点
 * 的 WebView。只有正对着的那一张跑，滑走就卸掉——同时跑十几个页面，手机先
 * 热起来。关掉时退回封面。
 *
 * 没有封面的页面铺一块底色加一行字，而不是跳过它——跳过等于让没截图的人
 * 永远排不上，而封面是发布时自动截的，新页面往往还没截到。
 */
export function Explore({
  token, autoPlay, searchFirst, onOpen, onRemix, onAuthor, onInstalled,
}: {
  token: string | null;
  autoPlay: boolean;
  /** 从助手「找一个」进来：一进来就把搜索打开。 */
  searchFirst?: boolean;
  /** 点卡片：用 WebView 正式打开这个页面。 */
  onOpen: (l: Listing) => void;
  /** 「照这个做一个」：带着做法（和想怎么改）去助手那一屏。 */
  onRemix: (seed: string) => void;
  onAuthor: (username: string) => void;
  /** 装了别人的页面之后，壳要重拉一次自己的页面列表。 */
  onInstalled: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'recommend' | 'event'>('recommend');
  const [sheet, setSheet] = useState<{ item: Listing; tab: 'comments' | 'remix' } | null>(null);
  /** null：没在搜。 */
  const [query, setQuery] = useState<string | null>(searchFirst ? '' : null);
  const { height } = Dimensions.get('window');

  const load = useCallback(() => {
    setLoading(true);
    void api.marketplace(token)
      .then((r) => setItems(r.listings))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [token]);
  useEffect(load, [load]);

  /*
   * 「M 人正在用」是活数字：presence 窗口 90 秒，这里 45 秒静默刷一次，
   * 让上下线在一个窗口内反映到流里。RN 没有 visibilitychange，
   * AppState.active 时才刷，退到后台的 App 不占请求。失败静默保持旧值，
   * 也不动 loading——那一圈转圈是「首次加载」的意思。
   */
  useEffect(() => {
    const t = setInterval(() => {
      if (AppState.currentState === 'active') {
        void api.marketplace(token)
          .then((r) => setItems(r.listings))
          .catch(() => undefined);
      }
    }, 45_000);
    return () => clearInterval(t);
  }, [token]);

  /* 正对着的那一张。自动播放只给它换令牌、装 WebView */
  const [current, setCurrent] = useState<string | null>(null);
  const onViewable = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const first = viewableItems[0]?.item as Listing | undefined;
    if (first) setCurrent(first.id);
  }).current;
  const viewability = useRef({ itemVisiblePercentThreshold: 60 }).current;

  /* 「1024」那一格只看带 1024 分类的作品，和电脑端那颗带点的分类是同一批 */
  const byTab = tab === 'event'
    ? items.filter((l) => (l.category ?? '').includes('1024'))
    : items;
  /* 搜的是名字、作者、简介和分类；推荐流就几十个页面，用不着服务端搜 */
  const q = (query ?? '').trim().toLowerCase();
  const shown = !q ? byTab : byTab.filter((l) =>
    [l.name, l.owner_name, l.owner_username, l.description ?? '', l.category ?? '']
      .some((x) => x.toLowerCase().includes(q)));

  const setLiked = (appId: string, liked: boolean, likeCount: number) => {
    setItems((prev) => prev.map((l) => (l.app_id === appId ? { ...l, liked, like_count: likeCount } : l)));
  };

  if (loading) {
    return (
      <View style={[s.full, s.center]}>
        <ActivityIndicator color="#72706a" />
      </View>
    );
  }

  return (
    <View style={s.full}>
      <FlatList
        data={shown}
        keyExtractor={(l) => l.id}
        pagingEnabled
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        getItemLayout={(_, i) => ({ length: height, offset: height * i, index: i })}
        onViewableItemsChanged={onViewable}
        viewabilityConfig={viewability}
        ListEmptyComponent={(
          <View style={[{ height }, s.center]}>
            <Text style={s.emptyText}>
              {q ? '没有搜到。换个词试试。'
                : tab === 'event' ? '还没有 1024 作品。' : '还没有同事把页面分享到全公司。'}
            </Text>
          </View>
        )}
        renderItem={({ item }) => (
          <Card
            item={item}
            height={height}
            token={token}
            live={autoPlay && (current ?? shown[0]?.id) === item.id}
            onOpen={() => onOpen(item)}
            onAuthor={() => onAuthor(item.owner_username)}
            onSheet={(t) => setSheet({ item, tab: t })}
            onLiked={setLiked}
          />
        )}
      />

      {/* 顶上：中间那粒胶囊，右边一颗搜索。浮在封面上，所以带一层半透明白底 */}
      <View style={[s.top, { paddingTop: insets.top + 10 }]} pointerEvents="box-none">
        {query === null ? (
          <>
            <View style={s.topPill}>
              {([['recommend', '推荐'], ['event', '1024']] as const).map(([k, label]) => (
                <Pressable key={k} onPress={() => setTab(k)} accessibilityRole="tab" hitSlop={6}>
                  <Text style={[s.topTab, tab === k ? s.topTabOn : null]}>{label}</Text>
                </Pressable>
              ))}
            </View>
            <Pressable style={s.topSearch} onPress={() => setQuery('')} accessibilityLabel="搜索">
              <Icon name="search" size={20} color="#181715" />
            </Pressable>
          </>
        ) : (
          <View style={s.searchBox}>
            <Icon name="search" size={18} color="#72706a" />
            <TextInput
              style={s.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder="找一个：会议室、工位、报销…"
              placeholderTextColor="#a2a09b"
              autoFocus
              returnKeyType="search"
            />
            <Pressable onPress={() => setQuery(null)} hitSlop={10}>
              <Text style={s.searchCancel}>取消</Text>
            </Pressable>
          </View>
        )}
      </View>

      {sheet && (
        <RemixSheet
          item={sheet.item}
          initialTab={sheet.tab}
          token={token}
          onClose={() => setSheet(null)}
          onRemix={(seed) => { setSheet(null); onRemix(seed); }}
          onInstalled={(appId, installed) => {
            setItems((prev) => prev.map((l) => (l.app_id === appId ? { ...l, installed } : l)));
            setSheet((prev) => (prev && prev.item.app_id === appId
              ? { ...prev, item: { ...prev.item, installed } } : prev));
            onInstalled();
          }}
        />
      )}
    </View>
  );
}

function Card({
  item, height, token, live, onOpen, onAuthor, onSheet, onLiked,
}: {
  item: Listing;
  height: number;
  token: string | null;
  /** 正对着、且开了自动播放：页面直接跑起来。 */
  live: boolean;
  onOpen: () => void;
  onAuthor: () => void;
  onSheet: (tab: 'comments' | 'remix') => void;
  onLiked: (appId: string, liked: boolean, likeCount: number) => void;
}) {
  const insets = useSafeAreaInsets();
  const cover = absCover(item.cover_path);
  /*
    手机页面的封面本来就是一张竖的手机截图（390×844），铺满正合适；电脑
    页面的封面是横的，铺满一张竖屏只剩中间一窄条——那就整张放进来，
    上下留底色，至少看得出是个什么页面。
  */
  const phone = item.type === 'h5';
  const [busy, setBusy] = useState(false);

  const toggleLike = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = item.liked ? await api.unlike(token, item.app_id) : await api.like(token, item.app_id);
      onLiked(item.app_id, r.liked, r.likeCount);
    } catch { /* 点赞失败就当没点：这一下不值得打断看页面的人 */ } finally { setBusy(false); }
  };

  return (
    <Pressable style={[s.card, { height }]} onPress={onOpen} accessibilityLabel={`打开 ${item.name}`}>
      {cover
        ? <Image source={{ uri: cover }} style={s.cover} resizeMode={phone ? 'cover' : 'contain'} />
        : (
          <View style={[s.cover, s.center, { backgroundColor: '#e4e1d9' }]}>
            <Text style={s.coverText}>{item.name}</Text>
            <Text style={s.coverHint}>还没有封面 · 点开看看</Text>
          </View>
        )}

      {live && <LivePage item={item} token={token} />}

      {/* 右侧动作栏。贴着底栏上方，和稿上一致 */}
      <View style={[s.rail, { bottom: insets.bottom + 108 }]}>
        <Pressable onPress={onAuthor} style={s.railAvatar} accessibilityLabel={item.owner_name}>
          <Text style={s.railAvatarText}>{lastChar(item.owner_name)}</Text>
        </Pressable>
        <RailBtn label={String(item.like_count)} onPress={() => void toggleLike()}>
          <Icon
            name="heart" size={30} strokeWidth={1.9}
            color={item.liked ? '#ee5c2a' : '#fff'} fill={item.liked ? '#ee5c2a' : undefined}
          />
        </RailBtn>
        <RailBtn label={String(item.comment_count)} onPress={() => onSheet('comments')}>
          <Icon name="msg" size={28} strokeWidth={1.9} color="#fff" />
        </RailBtn>
        <RailBtn
          label="分享"
          onPress={() => void Share.share({
            message: `${item.name}（${item.owner_name} 做的）${API_BASE}/${item.owner_username}/${item.slug}/`,
          })}
        >
          <Icon name="forward" size={28} strokeWidth={1.9} color="#fff" />
        </RailBtn>
        <RailBtn label="做同款" bold onPress={() => onSheet('remix')}>
          <Icon name="wand" size={28} strokeWidth={1.9} color="#fff" />
        </RailBtn>
      </View>

      {/* 左下那块信息。和动作栏同一条基线 */}
      <View style={[s.info, { bottom: insets.bottom + 108 }]} pointerEvents="none">
        <Text style={s.infoName} numberOfLines={1}>{item.name}</Text>
        <Text style={s.infoBy} numberOfLines={1}>
          {item.owner_name} · {item.install_count} 人复用
          {item.live_count > 0 ? ` · ${item.live_count} 人正在用` : ''}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * 跑起来的那个页面。
 *
 * 只看不点（pointerEvents none）：手指在这一屏上是用来上下刷的，页面要是
 * 接住了滑动，就刷不动了。想点进去用，点一下卡片正式打开。
 * 换不到令牌（没共享给你、下线了）就什么都不装，封面照旧在底下。
 */
function LivePage({ item, token }: { item: Listing; token: string | null }) {
  const [uri, setUri] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void api.playOpen(token, item.owner_username, item.slug)
      .then((r) => { if (alive) setUri(`${API_BASE}${r.url}`); })
      .catch(() => { /* 退回封面 */ });
    return () => { alive = false; };
  }, [token, item.owner_username, item.slug]);
  if (!uri) return null;
  return (
    <View style={[s.cover, { opacity: ready ? 1 : 0 }]} pointerEvents="none">
      <WebView
        source={{ uri }}
        style={{ flex: 1, backgroundColor: 'transparent' }}
        onLoadEnd={() => setReady(true)}
        scrollEnabled={false}
        mediaPlaybackRequiresUserAction
        setSupportMultipleWindows={false}
      />
    </View>
  );
}

/**
 * 「做同款灵感」。
 *
 * 平台还没有"看一个页面、给出改法"的接口，这里按页面所在的分类摆几条常见
 * 的改法——点一条就落进上面的输入框，人再改两个字。⟳ 换下一组。它们只是
 * 起个头：真正怎么改，是这个人自己说的那句。
 */
const IDEAS: Record<string, string[]> = {
  工作提效: ['节假日自动跳过，不用手动调整', '加一个导出成 Excel 的按钮', '每天早上 9 点提醒今天要办的', '加上审批人和处理进度'],
  小游戏: ['加一个排行榜，按部门比', '每局限时 60 秒', '输了可以把战绩分享给同事', '加上音效和震动'],
  数据看板: ['数字每 5 分钟自动刷新', '加一条和上周同期的对比线', '超过阈值时标红提醒', '能按部门筛选'],
  团队协作: ['换好之后同时通知两边的负责人', '加一张本周值班表', '按人统计这个月的次数', '支持评论和 @ 同事'],
  学习: ['做成每天一题的打卡', '答错的题自动进错题本', '加上进度条和连续天数', '能按难度筛选'],
  生活: ['随机推荐时排除最近吃过的', '加上步行时间', '人均价格可以筛选', '大家投票决定今天吃什么'],
  '1024 作品': ['换成自己组里的数据', '加一个大屏模式', '能扫码参与', '结束后生成一张战报'],
};
const IDEAS_ANY = ['换成深色主题', '在手机上一屏看完，不用横着滑', '加一个搜索框', '数据存到我自己的空间里'];

/**
 * 上拉的那张卡（04 做同款）。
 *
 * 两栏：评论和做同款。点那根魔杖进来停在「做同款」，点评论那颗进来停在
 * 「评论」——人点的是哪一颗，就是想看哪一边。
 */
function RemixSheet({
  item, initialTab, token, onClose, onRemix, onInstalled,
}: {
  item: Listing;
  initialTab: 'comments' | 'remix';
  token: string | null;
  onClose: () => void;
  onRemix: (seed: string) => void;
  onInstalled: (appId: string, installed: boolean) => void;
}) {
  const insets = useSafeAreaInsets();
  const [installing, setInstalling] = useState(false);
  const [tab, setTab] = useState<'comments' | 'remix'>(initialTab);
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [draft, setDraft] = useState('');
  const sending = useRef(false);
  /** 「描述你想怎么改…」 */
  const [change, setChange] = useState('');
  const ideas = IDEAS[exploreBucket(item.category)] ?? IDEAS_ANY;
  const [round, setRound] = useState(0);
  const pair = [ideas[(round * 2) % ideas.length]!, ideas[(round * 2 + 1) % ideas.length]!];

  const voice = useVoiceInput(
    (text) => setChange((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text)),
    { apiBase: API_BASE, token },
  );

  useEffect(() => {
    void api.comments(token, item.app_id)
      .then((r) => setComments(r.comments))
      .catch(() => setComments([]));
  }, [token, item.app_id]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending.current) return;
    sending.current = true;
    try {
      const r = await api.addComment(token, item.app_id, body);
      setComments((prev) => [r.comment, ...(prev ?? [])]);
      setDraft('');
    } catch { /* 失败就把字留在框里，用户自己重试 */ } finally { sending.current = false; }
  };

  /*
    带过去的是"做法"加"我想怎么改"。做法是作者当初说的那句（没有就只说照着
    哪个页面做）；改法是这个人刚写的。两段分开写，模型才分得清哪句是原样、
    哪句是要变的。
  */
  const go = () => {
    const base = item.source_prompt ?? `做一个和「${item.name}」类似的页面。`;
    const mine = change.trim();
    onRemix(mine ? `${base}\n\n我想这样改：${mine}` : base);
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.sheetBackdrop} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: insets.bottom + 18 }]}>
        <View style={s.sheetTabs}>
          {([['comments', `评论 ${comments?.length ?? item.comment_count}`], ['remix', '做同款']] as const).map(([k, label]) => (
            <Pressable key={k} style={s.sheetTab} onPress={() => setTab(k)} accessibilityRole="tab">
              <Text style={[s.sheetTabText, tab === k && s.sheetTabTextOn]}>{label}</Text>
              <View style={[s.sheetTabBar, tab === k && s.sheetTabBarOn]} />
            </Pressable>
          ))}
        </View>

        {tab === 'comments' ? (
          <View style={{ flex: 1 }}>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 12, gap: 16 }}>
              {comments === null && <Text style={s.dim}>正在加载…</Text>}
              {comments?.length === 0 && <Text style={s.dim}>还没有评论，来说说你的用法吧。</Text>}
              {comments?.map((c) => (
                <View key={c.id} style={s.comment}>
                  <View style={s.commentAvatar}>
                    <Text style={s.commentAvatarText}>{lastChar(c.author.displayName)}</Text>
                  </View>
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text style={s.commentWho}>{c.author.displayName}</Text>
                    <Text style={s.commentBody}>{c.body}</Text>
                  </View>
                </View>
              ))}
            </ScrollView>
            <View style={s.composer}>
              <TextInput
                style={s.composerInput}
                value={draft}
                onChangeText={setDraft}
                placeholder="写下评论…"
                placeholderTextColor="#a2a09b"
                maxLength={500}
                onSubmitEditing={() => void send()}
                returnKeyType="send"
              />
              <Pressable style={s.composerSend} onPress={() => void send()} accessibilityLabel="发送">
                <Text style={s.composerSendText}>发送</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
            <View style={s.changeBox}>
              <TextInput
                style={s.changeInput}
                value={change}
                onChangeText={setChange}
                placeholder="描述你想怎么改…"
                placeholderTextColor="#a2a09b"
                multiline
                maxLength={1000}
              />
              <Pressable
                hitSlop={10}
                accessibilityLabel="语音输入"
                disabled={!voice.available}
                style={!voice.available ? { opacity: 0.35 } : null}
                onPress={() => void voice.start()}
              >
                <Icon name={voice.listening ? 'stop' : 'mic'} size={22} color="#54524e" />
              </Pressable>
            </View>

            <View style={s.ideasHead}>
              <Text style={s.ideasTitle}>做同款灵感</Text>
              <Pressable onPress={() => setRound((r) => r + 1)} hitSlop={10} accessibilityLabel="换一组">
                <Icon name="refresh" size={20} color="#72706a" />
              </Pressable>
            </View>
            <View style={{ gap: 10 }}>
              {pair.map((idea) => (
                <Pressable
                  key={idea}
                  style={s.idea}
                  onPress={() => setChange((prev) => (prev.trim() ? `${prev.trim()}；${idea}` : idea))}
                >
                  <Icon name="sparkles" size={20} color="#ee5c2a" />
                  <Text style={s.ideaText}>{idea}</Text>
                </Pressable>
              ))}
            </View>

            <View style={{ flex: 1, minHeight: 12 }} />
            <Pressable style={s.cta} onPress={go}>
              <Text style={s.ctaText}>照这个做一个</Text>
            </Pressable>
            <Text style={s.ctaHint}>只带走做法，不带走{item.owner_name}的数据</Text>
            {/*
              「添加到我的」在稿上没有——稿里这一屏只有做同款。但手机端此前
              的创意市场是能装的，那条路没了的话，看到一个好用的页面就只剩
              "照着做一个"，而很多时候人要的就是直接用他那个。收成一行小字。
            */}
            {!item.mine && (
              <Pressable
                style={s.addLink}
                disabled={installing}
                onPress={() => {
                  setInstalling(true);
                  const fn = item.installed ? api.uninstallFromMarket : api.installFromMarket;
                  void fn(token, item.app_id)
                    .then(() => onInstalled(item.app_id, !item.installed))
                    .catch(() => undefined)
                    .finally(() => setInstalling(false));
                }}
              >
                <Text style={s.addLinkText}>
                  {item.installed ? '已添加到「我的」· 点此移除' : '不改，直接添加到「我的」'}
                </Text>
              </Pressable>
            )}
          </ScrollView>
        )}
      </View>
      <VoicePanel voice={voice} />
    </Modal>
  );
}

function RailBtn({
  label, bold, onPress, children,
}: { label: string; bold?: boolean; onPress: () => void; children: React.ReactNode }) {
  return (
    <Pressable style={s.railBtn} onPress={onPress} accessibilityLabel={label} hitSlop={6}>
      <View style={s.railIcon}>{children}</View>
      <Text style={[s.railLabel, bold && { fontWeight: '700' }]}>{label}</Text>
    </Pressable>
  );
}

/** 中文名取最后一个字，英文取首字母——和电脑端 initial() 同一条规则。 */
function lastChar(name: string): string {
  const t = (name || '').trim();
  if (!t) return '·';
  return /[一-龥]/.test(t) ? t.slice(-1) : t.slice(0, 1).toUpperCase();
}

const GLASS = 'rgba(255,255,255,.72)';

const s = StyleSheet.create({
  /*
    底色是浅的：稿上这一屏是浅底、状态栏黑字。电脑页面的横版封面整张放进来
    时，上下露出的就是这层底色。
  */
  full: { flex: 1, backgroundColor: '#e9e6df' },
  center: { alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: '#72706a', fontSize: 15, paddingHorizontal: 32, textAlign: 'center' },

  card: { width: '100%', backgroundColor: '#e9e6df' },
  cover: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
  coverText: { fontSize: 22, fontWeight: '800', color: 'rgba(24,23,21,.6)' },
  coverHint: { marginTop: 6, fontSize: 13, color: 'rgba(24,23,21,.4)' },

  top: {
    position: 'absolute', left: 0, right: 0, top: 0,
    flexDirection: 'row', justifyContent: 'center', paddingHorizontal: 16,
  },
  topPill: {
    flexDirection: 'row', gap: 18, height: 42, paddingHorizontal: 20, borderRadius: 21,
    backgroundColor: GLASS, alignItems: 'center',
  },
  topTab: { fontSize: 16, fontWeight: '600', color: '#72706a' },
  topTabOn: { color: '#181715', fontWeight: '700' },
  topSearch: {
    position: 'absolute', right: 16, bottom: 0, width: 42, height: 42, borderRadius: 21,
    backgroundColor: GLASS, alignItems: 'center', justifyContent: 'center',
  },
  searchBox: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, height: 42,
    paddingLeft: 14, paddingRight: 4, borderRadius: 21, backgroundColor: 'rgba(255,255,255,.94)',
  },
  searchInput: { flex: 1, fontSize: 15, color: '#181715', paddingVertical: 0 },
  searchCancel: { fontSize: 15, color: '#54524e', paddingHorizontal: 10 },

  rail: { position: 'absolute', right: 12, alignItems: 'center', gap: 16 },
  railAvatar: {
    width: 48, height: 48, borderRadius: 24, backgroundColor: '#fbf3e0',
    alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 0 2px #ffffff',
  },
  railAvatarText: { fontSize: 18, fontWeight: '700', color: '#181715' },
  railBtn: { alignItems: 'center', gap: 2 },
  /* 白描边落在浅色封面上会看不见，稿上每颗都垫了一层投影 */
  railIcon: { filter: 'drop-shadow(0px 1px 3px rgba(0,0,0,0.35))' },
  railLabel: {
    fontSize: 13, fontWeight: '600', color: '#fff',
    textShadowColor: 'rgba(0,0,0,.35)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4,
  },

  info: {
    position: 'absolute', left: 16, maxWidth: '62%', gap: 2,
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 16,
    backgroundColor: 'rgba(24,23,21,.46)',
  },
  infoName: { fontSize: 15, fontWeight: '700', color: '#fff' },
  infoBy: { fontSize: 13, color: 'rgba(255,255,255,.8)' },

  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(24,23,21,.4)' },
  /* 稿上是 58%；多了一行「直接添加到我的」，不放高一点「照这个做一个」就被挤出卡外 */
  sheet: {
    height: '64%', backgroundColor: '#f3f1ec',
    borderTopLeftRadius: 30, borderTopRightRadius: 30, paddingHorizontal: 18,
  },
  sheetTabs: { flexDirection: 'row', paddingTop: 16 },
  sheetTab: { flex: 1, alignItems: 'center', gap: 10 },
  sheetTabText: { fontSize: 18, fontWeight: '600', color: '#72706a' },
  sheetTabTextOn: { color: '#181715', fontWeight: '800' },
  sheetTabBar: { width: 40, height: 4, borderRadius: 4, backgroundColor: 'transparent' },
  sheetTabBarOn: { backgroundColor: '#ee5c2a' },

  dim: { fontSize: 14, lineHeight: 22, color: '#72706a', paddingVertical: 12 },

  comment: { flexDirection: 'row', gap: 10 },
  commentAvatar: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: '#ffede0',
    alignItems: 'center', justifyContent: 'center',
  },
  commentAvatarText: { fontSize: 15, fontWeight: '700', color: '#181715' },
  commentWho: { fontSize: 13, color: '#72706a' },
  commentBody: { fontSize: 15, lineHeight: 22, color: '#181715' },

  composer: {
    flexDirection: 'row', alignItems: 'center', gap: 8, height: 50,
    paddingLeft: 16, paddingRight: 6, borderRadius: 25, backgroundColor: '#fff',
  },
  composerInput: { flex: 1, fontSize: 15, color: '#181715' },
  composerSend: { height: 38, paddingHorizontal: 16, borderRadius: 19, backgroundColor: '#ee5c2a', justifyContent: 'center' },
  composerSendText: { fontSize: 14, fontWeight: '700', color: '#fff' },

  changeBox: {
    height: 130, marginTop: 16, paddingHorizontal: 18, paddingVertical: 16, borderRadius: 24,
    backgroundColor: '#fff', justifyContent: 'space-between',
    boxShadow: '0 10px 24px -16px rgba(24,23,21,.3)',
  },
  changeInput: { flex: 1, fontSize: 16, lineHeight: 23, color: '#181715', padding: 0, textAlignVertical: 'top' },
  ideasHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 20, paddingBottom: 12, paddingHorizontal: 2,
  },
  ideasTitle: { fontSize: 17, fontWeight: '700', color: '#181715' },
  idea: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderRadius: 20, backgroundColor: '#fbfaf7',
  },
  ideaText: { flex: 1, fontSize: 15, fontWeight: '600', color: '#181715' },

  cta: {
    height: 58, borderRadius: 29, backgroundColor: '#ee5c2a', alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 12px 24px -12px rgba(238,92,42,.8)',
  },
  ctaText: { fontSize: 17, fontWeight: '700', color: '#fff' },
  ctaHint: { paddingTop: 10, textAlign: 'center', fontSize: 13, color: '#72706a' },
  addLink: { alignSelf: 'center', paddingTop: 8, paddingHorizontal: 12 },
  addLinkText: { fontSize: 13, fontWeight: '600', color: '#54524e', textDecorationLine: 'underline' },
});
