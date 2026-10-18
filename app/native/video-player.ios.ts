/**
 * iOS twin of video-player.ts over FaceclawKitIosVideoPlayer (AVPlayer in
 * shared Kotlin). Frames are not submitted natively: onFrame asks the window
 * to repaint, and its paint reads lastFrame().
 */
import { GrayImage } from "../graphics/image";
import { kotlinListener } from "./kotlin-listener.ios";
import type { VideoInfo, VideoPlaybackState, VideoPlayerCallbacks, VideoStartOptions } from "./video-player";

export type { VideoInfo, VideoPlaybackState, VideoPlayerCallbacks, VideoStartOptions };


/** Containers AVFoundation opens (no MKV or WebM). */
const PLAYABLE_VIDEO = /\.(mp4|m4v|mov|3gp)$/i;

export function isPlayableVideoFile(name: string): boolean {
  return PLAYABLE_VIDEO.test(name);
}

export function probeVideo(path: string): VideoInfo | { error: string } {
  try {
    const raw = JSON.parse(String(FaceclawKitIosVideoPlayer.new().probePath(path)));
    if (raw.error) return { error: String(raw.error) };
    return {
      width: Number(raw.width) || 0,
      height: Number(raw.height) || 0,
      durationMs: Number(raw.durationMs) || 0,
      hasAudio: Boolean(raw.hasAudio),
    };
  } catch (error) {
    return { error: String(error) };
  }
}

/** One player; plays into the latest start()'s rect size (x/y and surfaceId are the window's). Main thread only. */
export class VideoPlayer {
  private readonly player = FaceclawKitIosVideoPlayer.new();
  // Kotlin calls this; keep it referenced.
  private readonly listener: FaceclawKitIosVideoListener;

  constructor(callbacks: VideoPlayerCallbacks) {
    this.listener = kotlinListener(FaceclawKitIosVideoListener, {
      onStateChangedStatePositionMs: (state: string, positionMs: number) =>
        callbacks.onState(String(state) as VideoPlaybackState, Number(positionMs)),
      onErrorMessage_: (message: string) => callbacks.onError(String(message ?? "Playback failed")),
      onFrame: () => callbacks.onFrame?.(),
    });
    this.player.setListenerListener(this.listener);
  }

  start(options: VideoStartOptions): void {
    this.player.startPathWidthHeightMonochromeGammaAudioStartMs(options.path, Math.round(options.rect.width),
      Math.round(options.rect.height), options.monochrome, options.gamma, options.audio, Math.max(0, Math.round(options.startMs)));
  }

  pause(): void {
    this.player.pause();
  }

  resume(): void {
    this.player.resume();
  }

  seekTo(positionMs: number): void {
    this.player.seekToPositionMs(Math.max(0, Math.round(positionMs)));
  }

  positionMs(): number {
    return Number(this.player.positionMs());
  }

  isPlaying(): boolean {
    return Boolean(this.player.isPlaying());
  }

  /** The latest frame at the given size, or null before one exists. */
  lastFrame(width: number, height: number): GrayImage | null {
    const data = this.player.lastFrameWidthHeight(width, height);
    if (!data) return null;
    const image = new GrayImage(width, height, 0);
    image.pixels.set(new Uint8Array(interop.bufferFromData(data)));
    return image;
  }

  stop(): void {
    this.player.stop();
  }

  release(): void {
    this.player.stop();
    this.player.setListenerListener(null);
  }
}
