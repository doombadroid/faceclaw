const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

const STATE = { Stopped: 0, Playing: 1, Paused: 2, Interrupted: 3, SeekingForward: 4, SeekingBackward: 5 };
const AUTH = { NotDetermined: 0, Denied: 1, Restricted: 2, Authorized: 3 };

function setup() {
  const calls = [], observers = new Map(), opened = [], decoded = [];
  let auth = AUTH.Authorized, otherAudio = false, requestDone = null;
  const item = { persistentID: 42, title: 'Song', artist: 'Band', albumTitle: 'Album', playbackDuration: 200,
    artwork: { imageWithSize: size => ({ size }) } };
  const player = { nowPlayingItem: item, playbackState: STATE.Playing, currentPlaybackTime: 12.5,
    beginGeneratingPlaybackNotifications: () => calls.push('begin'), endGeneratingPlaybackNotifications: () => calls.push('end'),
    play: () => calls.push('play'), pause: () => calls.push('pause'),
    skipToNextItem: () => calls.push('next'), skipToPreviousItem: () => calls.push('previous') };
  const center = {
    addObserverForNameObjectQueueUsingBlock: (name, object, _queue, block) => { assert.equal(object, player); observers.set(name, block); return name; },
    removeObserver: name => observers.delete(name),
  };
  const api = loader({
    MPMusicPlayerController: { systemMusicPlayer: player }, MPMusicPlaybackState: STATE,
    MPMediaLibrary: { authorizationStatus: () => auth, requestAuthorization: done => { requestDone = done; } },
    MPMediaLibraryAuthorizationStatus: AUTH,
    MPMusicPlayerControllerNowPlayingItemDidChangeNotification: 'item', MPMusicPlayerControllerPlaybackStateDidChangeNotification: 'state',
    NSNotificationCenter: { defaultCenter: center }, NSOperationQueue: { mainQueue: 'main' },
    AVAudioSession: { sharedInstance: () => ({ otherAudioPlaying: otherAudio }) },
    CGSizeMake: (width, height) => ({ width, height }), UIImagePNGRepresentation: image => ({ png: image }),
  }, {
    '@nativescript/core': { Utils: { openUrl: url => opened.push(url), executeOnMainThread: fn => fn() } },
    './image-bytes': { decodeImageBytes: (bytes, width, height) => { decoded.push([bytes, width, height]); return { width, height }; } },
    './kotlin-data': { fromData: data => ({ buffer: data }) },
  })('app/native/media-controller.ios.ts');
  return { api, bridge: new api.FaceclawMediaControllerBridge(), player, item, calls, observers, opened, decoded,
    setAuth: value => { auth = value; }, setOtherAudio: value => { otherAudio = value; }, grant: status => requestDone(status) };
}

test('iOS media snapshot reads Apple Music live and maps playback states', () => {
  const f = setup();
  const state = f.bridge.snapshot();
  assert.deepEqual({ ...state }, { available: true, accessEnabled: true, packageName: 'com.apple.Music', appName: 'Music',
    playbackState: 'playing', title: 'Song', artist: 'Band', album: 'Album', positionMs: 12500, durationMs: 200000,
    playbackSpeed: 1, status: '', canPlayPause: true, canSkipNext: true, canSkipPrevious: true, artVersion: state.artVersion });
  const mapped = Object.entries({ Stopped: 'stopped', Paused: 'paused', Interrupted: 'paused', SeekingForward: 'playing', SeekingBackward: 'playing' });
  for (const [native, expected] of mapped) {
    f.player.playbackState = STATE[native];
    assert.equal(f.bridge.snapshot().playbackState, expected, native);
  }
  assert.equal(f.bridge.snapshot().playbackSpeed, 1, 'seeking still advances');
  f.player.playbackState = STATE.Paused;
  assert.equal(f.bridge.snapshot().playbackSpeed, 0);
});

test('iOS media art version changes only with the playing item', () => {
  const f = setup();
  const first = f.bridge.snapshot().artVersion;
  assert.equal(f.bridge.snapshot().artVersion, first);
  f.player.nowPlayingItem = { ...f.item, persistentID: 43 };
  assert.notEqual(f.bridge.snapshot().artVersion, first);
  assert.deepEqual({ ...f.bridge.getAlbumArt(96) }, { width: 96, height: 96 });
  assert.deepEqual(f.decoded[0], [{ png: { size: { width: 96, height: 96 } } }, 96, 96]);
  f.player.nowPlayingItem = { ...f.item, artwork: null };
  assert.equal(f.bridge.getAlbumArt(96), null);
});

test('iOS media without Apple Music access or item reports why, and never claims control', () => {
  const f = setup();
  f.setAuth(AUTH.Denied);
  let state = f.bridge.snapshot();
  assert.equal(state.accessEnabled, false); assert.equal(state.available, false); assert.equal(state.title, '');
  assert.equal(state.canPlayPause, false); assert.match(state.status, /Apple Music access/);
  f.setAuth(AUTH.Authorized); f.player.nowPlayingItem = null; f.player.playbackState = STATE.Stopped;
  state = f.bridge.snapshot();
  assert.equal(state.playbackState, 'idle'); assert.equal(state.status, ''); assert.equal(state.canSkipNext, false);
  f.setOtherAudio(true);
  assert.match(f.bridge.snapshot().status, /another app/);
  assert.deepEqual([...f.bridge.getQueue()], []); assert.equal(f.bridge.getMediaVolumePercent(), -1);
  f.bridge.setMediaVolumePercent(50); f.bridge.skipToQueueItem(1);
  assert.equal(f.bridge.getAlbumArt(96), null);
});

test('iOS media controls toggle Apple Music and listeners follow player notifications', async () => {
  const f = setup(), seen = [];
  const off = f.bridge.onStateChange(state => seen.push(state.playbackState));
  await f.bridge.playPause();
  f.player.playbackState = STATE.Paused;
  await f.bridge.playPause(); await f.bridge.skipNext(); await f.bridge.skipPrevious();
  await f.bridge.start(); await f.bridge.start();
  assert.deepEqual(f.calls, ['pause', 'play', 'next', 'previous', 'begin']);
  assert.deepEqual([...f.observers.keys()], ['item', 'state']);
  f.observers.get('state')();
  assert.deepEqual(seen, ['playing', 'paused']);
  off(); await f.bridge.stop();
  assert.equal(f.observers.size, 0); assert.equal(f.calls.at(-1), 'end');
});

test('iOS media access asks once, then sends a denied user to Settings', () => {
  const f = setup(), seen = [];
  f.setAuth(AUTH.NotDetermined);
  f.bridge.onStateChange(state => seen.push(state.accessEnabled));
  f.bridge.openNotificationAccessSettings();
  f.setAuth(AUTH.Authorized); f.grant(AUTH.Authorized);
  assert.deepEqual(seen, [false, true]); assert.deepEqual(f.opened, []);
  f.bridge.openNotificationAccessSettings();
  assert.deepEqual(f.opened, [], 'already authorized');
  f.setAuth(AUTH.Denied); f.bridge.openNotificationAccessSettings();
  assert.deepEqual(f.opened, ['app-settings:']);
});

test('Glanceboard music widget paints the iOS bridge title and its access status', () => {
  let state = {};
  const texts = [];
  const { MusicWidget } = loader({ global: { isIOS: true } }, {
    '../../../graphics/image': { GrayImage: class {} }, '../../../graphics/icons': { renderIcon: () => null },
    '../../../graphics/textwrap': { truncateText: (_font, text) => text },
    '../../../native/media-controller': { mediaControllerBridge: { snapshot: () => state, getAlbumArt: () => null } },
    '../../../ui/dashboard-settings': { ConfigSettingBoolean: class { get() { return false; } }, onAnySettingChanged() {}, toggleSettingMenuItem() {} },
    '../../../ui/menu': {}, '../../../util/numeric-util': { clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)) },
    '../glance-font': { glanceFont: { medium: () => ({ lineHeight: 20, measureText: () => 10 }), small: () => ({ lineHeight: 14, measureText: () => 10 }) } },
  })('app/apps/glanceboard/widgets/music-widget.ts');
  const image = { width: 288, height: 144, drawText: (_font, _x, _y, text) => texts.push(text), drawRect() {}, fillRect() {}, drawImage() {} };
  const paint = value => { state = value; texts.length = 0; new MusicWidget().paint(image); return [...texts]; };
  assert.deepEqual(paint({ available: false, accessEnabled: false, status: 'Allow Apple Music access on your iPhone.' }),
    ['Music', 'Allow Apple Music access on your iPhone.']);
  assert.deepEqual(paint({ available: false, accessEnabled: true, status: 'Audio is playing in another app; iPhone only shares Apple Music.' }),
    ['Music', 'Audio is playing in another app; iPhone only shares Apple Music.']);
  assert.deepEqual(paint({ available: false, accessEnabled: true, status: '' }), []);
  assert.deepEqual(paint({ available: true, accessEnabled: true, title: 'Song', artist: 'Band', album: '', playbackState: 'playing',
    positionMs: 1000, durationMs: 60000, status: '' }).slice(0, 2), ['Song', 'Band']);
});
