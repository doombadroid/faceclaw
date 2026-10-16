import { Utils } from '@nativescript/core'
import type { GrayImage } from '../graphics/image'
import { decodeImageBytes } from './image-bytes'
import { fromData } from './kotlin-data'
import type { MediaControllerState, MediaPlaybackState, MediaQueueItem } from './media-controller'
export type { MediaControllerState, MediaPlaybackState, MediaQueueItem } from './media-controller'

const ACCESS_NEEDED = 'Allow Apple Music access on your iPhone.'
const OTHER_APP = 'Audio is playing in another app; iPhone only shares Apple Music.'

function playbackState(state: MPMusicPlaybackState): MediaPlaybackState {
  switch (state) {
    case MPMusicPlaybackState.Playing: case MPMusicPlaybackState.SeekingForward: case MPMusicPlaybackState.SeekingBackward: return 'playing'
    case MPMusicPlaybackState.Paused: case MPMusicPlaybackState.Interrupted: return 'paused'
    case MPMusicPlaybackState.Stopped: return 'stopped'
    default: return 'unknown'
  }
}

/**
 * Apple Music through the system player: iOS gives third-party apps no other
 * app's now-playing or controls (that would need an AMS relay in the glasses
 * firmware). No queue or system volume either.
 */
export class FaceclawMediaControllerBridge {
  private readonly stateListeners = new Set<(state: MediaControllerState) => void>()
  private observers: any[] = []
  private itemId = ''
  private artVersion = 0

  onStateChange(listener: (state: MediaControllerState) => void): () => void {
    this.stateListeners.add(listener)
    listener(this.snapshot())
    return () => this.stateListeners.delete(listener)
  }

  /** Read live: player notifications don't arrive while the app is suspended between BLE wakes. */
  snapshot(): MediaControllerState {
    const player = MPMusicPlayerController.systemMusicPlayer
    const accessEnabled = MPMediaLibrary.authorizationStatus() === MPMediaLibraryAuthorizationStatus.Authorized
    const item = accessEnabled ? player.nowPlayingItem : null
    const id = item ? String(item.persistentID) : ''
    if (id !== this.itemId) { this.itemId = id; this.artVersion++ }
    const state = item ? playbackState(player.playbackState) : 'idle'
    return {
      available: !!item, accessEnabled, packageName: item ? 'com.apple.Music' : '', appName: item ? 'Music' : '',
      playbackState: state, title: item?.title ?? '', artist: item?.artist ?? '', album: item?.albumTitle ?? '',
      positionMs: item ? player.currentPlaybackTime * 1000 : -1, durationMs: item ? item.playbackDuration * 1000 : -1,
      playbackSpeed: state === 'playing' ? 1 : 0,
      status: !accessEnabled ? ACCESS_NEEDED : state !== 'playing' && AVAudioSession.sharedInstance().otherAudioPlaying ? OTHER_APP : '',
      canPlayPause: !!item, canSkipNext: !!item, canSkipPrevious: !!item, artVersion: this.artVersion,
    }
  }

  async start(): Promise<void> {
    if (this.observers.length) return
    const player = MPMusicPlayerController.systemMusicPlayer
    player.beginGeneratingPlaybackNotifications()
    this.observers = [MPMusicPlayerControllerNowPlayingItemDidChangeNotification, MPMusicPlayerControllerPlaybackStateDidChangeNotification]
      .map(name => NSNotificationCenter.defaultCenter.addObserverForNameObjectQueueUsingBlock(name, player, NSOperationQueue.mainQueue, () => this.notify()))
  }

  async stop(): Promise<void> {
    if (!this.observers.length) return
    for (const observer of this.observers) NSNotificationCenter.defaultCenter.removeObserver(observer)
    this.observers = []
    MPMusicPlayerController.systemMusicPlayer.endGeneratingPlaybackNotifications()
  }

  async playPause(): Promise<void> {
    const player = MPMusicPlayerController.systemMusicPlayer
    if (player.playbackState === MPMusicPlaybackState.Playing) player.pause()
    else player.play()
  }

  async skipNext(): Promise<void> { MPMusicPlayerController.systemMusicPlayer.skipToNextItem() }

  async skipPrevious(): Promise<void> { MPMusicPlayerController.systemMusicPlayer.skipToPreviousItem() }

  /** Asks for Apple Music access once; after a refusal, opens this app's Settings page. */
  openNotificationAccessSettings(): void {
    const status = MPMediaLibrary.authorizationStatus()
    if (status === MPMediaLibraryAuthorizationStatus.NotDetermined) {
      MPMediaLibrary.requestAuthorization(() => Utils.executeOnMainThread(() => this.notify()))
    } else if (status !== MPMediaLibraryAuthorizationStatus.Authorized) void Utils.openUrl('app-settings:')
  }

  async skipToQueueItem(_id: number): Promise<void> {}

  getMediaVolumePercent(): number { return -1 }

  setMediaVolumePercent(_volumePercent: number): void {}

  getAlbumArt(maxSize: number): GrayImage | null {
    if (MPMediaLibrary.authorizationStatus() !== MPMediaLibraryAuthorizationStatus.Authorized) return null
    const art = MPMusicPlayerController.systemMusicPlayer.nowPlayingItem?.artwork?.imageWithSize(CGSizeMake(maxSize, maxSize))
    const png = art && UIImagePNGRepresentation(art)
    // ponytail: flat gray, no PHOTO_TONE gamma/dither as Android has; add a TS tone pass if art looks washed out.
    return png ? decodeImageBytes(fromData(png).buffer, maxSize, maxSize) : null
  }

  getQueue(): MediaQueueItem[] { return [] }

  private notify(): void {
    for (const listener of this.stateListeners) listener(this.snapshot())
  }
}

export const mediaControllerBridge = new FaceclawMediaControllerBridge()
