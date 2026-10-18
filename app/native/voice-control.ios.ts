import type { FrameMetaListener, RawPcmListener, VoiceControlState, VoiceTranscriptEvent } from './voice-control'
import type { CloudSttClient, CloudSttTranscriptEvent } from './cloud-stt'
import { createCloudSttClient, usesCloudStt, type VoiceProviderSelection } from './cloud-stt-provider'
import { ReconnectingSttClient } from './reconnecting-stt'
import { createOnboardSttClient, createSpeakerVerifier, onboardModel, onboardModelError, type SpeakerVerifier } from './onboard-stt.ios'
import { APP_NAME } from '../branding'
import { FaceclawCommunicatorBridge } from './faceclaw-communicator.ios'
import { fromData, toData } from './kotlin-data'
import { wearerVerificationOptions } from '../apps/microphones/speakers'

export type IosMicrophoneSession = {
  setMicrophone(enabled: boolean, listener?: (packet: Uint8Array) => void): Promise<void>
}
/** How long a cloud provider gets, after the last audio, to send its final transcript. */
const CLOUD_FINAL_TIMEOUT_MS = 5000
type CaptureHolder = 'ptt' | 'continuous'

/** iOS implementation of the shared voice dialog's event bridge. Audio comes
 * from the glasses when connected, or the default phone input in preview mode,
 * and is transcribed by Apple's on-device recognizer, a downloaded sherpa-onnx
 * model (Moonshine / Whisper, fed PCM like a cloud provider) or a cloud provider.
 */
export class IosVoiceControlBridge {
  private native: FaceclawSpeech | null = null
  private readonly statuses = new Set<(state: VoiceControlState) => void>()
  private readonly transcripts = new Set<(event: VoiceTranscriptEvent) => void>()
  private readonly ends = new Set<() => void>()
  private readonly pauses = new Set<() => void>()
  // The mic is one shared stream; these are the reasons it runs (Android's
  // model). A second holder joins the live stream, and it stops with the last.
  // A continuous holder whose glasses session ended waits in suspended.
  private readonly holders = new Set<CaptureHolder>()
  private readonly suspended = new Set<CaptureHolder>()
  private status = 'Voice input ready.'
  private generation = 0
  private session: IosMicrophoneSession | null = null
  private source: 'glasses' | 'phone' | null = null
  private capturing = false
  private finalizing = false
  private completion: Promise<void> = Promise.resolve()
  private resolveCompletion: (() => void) | null = null
  private audioTimer: ReturnType<typeof setTimeout> | null = null
  private packets = 0
  private log: (message: string) => void = () => {}
  // Non-null while a cloud provider owns the transcript; FaceclawSpeech then
  // only supplies PCM. cloudEndStatus is set once the audio has ended and the
  // provider was asked to finalize; it is the status shown when it does.
  private cloud: CloudSttClient | null = null
  private recognition = 'on-device'
  // "My voice only" on a push-to-talk capture fed as PCM (a cloud provider or a
  // downloaded model): a non-wearer's final is emptied, as on Android. Apple's
  // recognizer gets no PCM here, so its captures are not verified.
  private verifier: SpeakerVerifier | null = null
  private cloudEndStatus: string | null = null
  private cloudTimer: ReturnType<typeof setTimeout> | null = null
  // Android's decode-only raw tap (Microphones, EvenHub mic apps): it runs while
  // any owner wants it and no STT holder does. STT preempts it; owners stay, and
  // resumeRawCapture (every acked frame) brings it back. One enable at a time:
  // setMicrophone blocks the main thread on its ACK.
  private readonly rawOwners = new Set<string>()
  private readonly rawPcm = new Set<RawPcmListener>()
  private readonly frameMeta = new Set<FrameMetaListener>()
  private rawSession: FaceclawCommunicatorBridge | null = null
  private rawGeneration = 0
  private rawStarting = false
  private rawLive = false

  onStatus(listener: (state: VoiceControlState) => void): () => void {
    this.statuses.add(listener); listener({ status: this.status, listening: this.capturing, detail: '' }); return () => { this.statuses.delete(listener) }
  }
  onTranscript(listener: (event: VoiceTranscriptEvent) => void): () => void {
    this.transcripts.add(listener); return () => { this.transcripts.delete(listener) }
  }
  onSpeechEnd(listener: () => void): () => void { this.ends.add(listener); return () => { this.ends.delete(listener) } }
  /** A silence endpoint in continuous capture, after that utterance's final. */
  onSpeechPause(listener: () => void): () => void { this.pauses.add(listener); return () => { this.pauses.delete(listener) } }
  private setStatus(status: string): void { this.status = status; for (const fn of [...this.statuses]) fn({ status, listening: this.capturing, detail: '' }) }
  private ensureNative(): FaceclawSpeech {
    if (!this.native) {
      this.native = FaceclawSpeech.new()
      this.native.eventHandler = (json: string) => this.receive(JSON.parse(json))
      this.native.pcmHandler = (pcm: NSData) => {
        this.verifier?.acceptPcm(pcm)
        this.cloud?.acceptPcm(new Uint8Array(interop.bufferFromData(pcm)).slice())
      }
    }
    return this.native
  }
  async prepare(foreground: boolean, usePhoneMic: boolean, voice: VoiceProviderSelection): Promise<boolean> {
    // Only Apple's recognizer needs Speech Recognition; a cloud provider or a downloaded model just needs audio.
    if (!usesCloudStt(voice) && !onboardModel(voice.provider)) {
      let status = FaceclawSpeech.authorizationStatus()
      if (status === 0) {
        if (!foreground) { this.setStatus(`Open ${APP_NAME} on the phone once to allow Speech Recognition.`); return false }
        status = await new Promise<number>(resolve => FaceclawSpeech.requestAuthorization(resolve))
      }
      if (status !== 3) { this.setStatus(`Allow Speech Recognition for ${APP_NAME} in iPhone Settings.`); return false }
    }
    if (usePhoneMic) {
      let microphoneStatus = FaceclawSpeech.microphoneAuthorizationStatus()
      if (microphoneStatus === 0) {
        if (!foreground) { this.setStatus(`Open ${APP_NAME} on the phone to allow microphone access.`); return false }
        microphoneStatus = await new Promise<number>(resolve => FaceclawSpeech.requestMicrophoneAuthorization(resolve))
      }
      if (microphoneStatus !== 3) { this.setStatus(`Allow Microphone access for ${APP_NAME} in iPhone Settings.`); return false }
    }
    return true
  }
  get statusText(): string { return this.status }
  /** Decoded glasses mic PCM (16 kHz mono S16LE) while the raw tap runs. */
  onRawPcm(listener: RawPcmListener): () => void { this.rawPcm.add(listener); return () => { this.rawPcm.delete(listener) } }
  /** The firmware's per-packet DSP trailer (direction-of-arrival, SSR). */
  onFrameMeta(listener: FrameMetaListener): () => void { this.frameMeta.add(listener); return () => { this.frameMeta.delete(listener) } }
  /** Android's contract; the tap always uses the active session, so `communicator` is unused. */
  startRawCapture(options: { communicator?: unknown; owner: string }): boolean {
    this.rawOwners.add(options.owner); return this.startRawTap()
  }
  stopRawCapture(owner: string): void { this.rawOwners.delete(owner); if (!this.rawOwners.size) this.endRawTap(true) }
  /** Starting, or enabled and still enabled in the session (a reconnect or suspend drops it silently). */
  isRawCaptureLive(): boolean { return this.rawStarting || this.rawLive && !!this.rawSession?.isAudioCaptureActive() }
  /** Restart a tap STT or the last session ended; cheap, called per acked frame. */
  resumeRawCapture(): void { if (this.rawOwners.size) this.startRawTap() }
  private startRawTap(): boolean {
    if (this.isRawCaptureLive()) return true
    // An STT holder owns the mic, even while it waits for a new session.
    if (this.holders.size || this.suspended.size) return false
    const session = FaceclawCommunicatorBridge.getActive()
    if (!session?.isSessionReady()) return false
    const generation = ++this.rawGeneration, decoder = FaceclawLc3Decoder.new()
    this.rawSession = session; this.rawStarting = true; this.rawLive = false
    const current = () => generation === this.rawGeneration
    session.setMicrophone(true, packet => { if (current()) this.receiveRaw(decoder, packet) })
      // A refused enable (display path not ready yet) retries on the next frame.
      .then(() => { if (current()) this.rawLive = true }, () => {})
      .finally(() => { if (current()) this.rawStarting = false })
    return true
  }
  /** Stops delivery; `release` also disables the mic (not when STT takes it over). */
  private endRawTap(release: boolean): void {
    if (!this.rawStarting && !this.rawLive) return
    ++this.rawGeneration; this.rawStarting = this.rawLive = false
    const session = this.rawSession; this.rawSession = null
    if (release) void session?.setMicrophone(false).catch(() => {})
  }
  private receiveRaw(decoder: FaceclawLc3Decoder, packet: Uint8Array): void {
    const pcm = decoder.decodePacket(toData(packet))
    // Wrong length, duplicate from the other arm, or a decode error.
    if (!pcm?.length) return
    const bytes = fromData(pcm)
    for (const fn of [...this.rawPcm]) fn(bytes)
    if (!this.frameMeta.size) return
    // Lc3PacketFramer's trailer: SSR at 200, angle at 202, both s16 LE.
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
    const meta = { angleDegrees: view.getInt16(202, true), ssr: view.getInt16(200, true) }
    for (const fn of [...this.frameMeta]) fn(meta)
  }
  startGlassesCapture(session: IosMicrophoneSession, voice: VoiceProviderSelection, log: (message: string) => void, endpointing = false): Promise<void> {
    return this.acquire('ptt', session, voice, log, endpointing)
  }
  startPhoneCapture(voice: VoiceProviderSelection, log: (message: string) => void, endpointing = false): Promise<void> {
    return this.acquire('ptt', null, voice, log, endpointing)
  }
  /** Transcribe-style capture from the glasses (or the phone when null): it rolls
   * from utterance to utterance until stopContinuousCapture. */
  startContinuousCapture(session: IosMicrophoneSession | null, voice: VoiceProviderSelection, log: (message: string) => void): Promise<void> {
    return this.acquire('continuous', session, voice, log, false)
  }
  stopContinuousCapture(): void {
    this.suspended.delete('continuous')
    if (!this.holders.delete('continuous')) return
    if (this.holders.size) { this.native.continuous = false; return }
    this.teardown()
  }
  hasSuspendedCapture(): boolean { return this.suspended.size > 0 }
  /** Whether anyone holds the mic, including across a session outage (Android's contract). */
  isCaptureHeld(): boolean { return this.holders.size > 0 || this.suspended.size > 0 }
  /** A new glasses session is up (or the glasses unlocked): restart a parked continuous capture. */
  resumeCapture(session: IosMicrophoneSession, voice: VoiceProviderSelection, log: (message: string) => void): Promise<void> {
    if (!this.suspended.delete('continuous')) return Promise.resolve()
    return this.startContinuousCapture(session, voice, log)
  }
  private async acquire(holder: CaptureHolder, session: IosMicrophoneSession | null, voice: VoiceProviderSelection, log: (message: string) => void, endpointing: boolean): Promise<void> {
    this.suspended.delete(holder)
    // STT preempts the raw tap; a glasses capture's own enable takes the mic over.
    this.endRawTap(!session)
    // Transcripts already reach every listener, so a second holder just joins.
    if (this.capturing && this.holders.size) { this.holders.add(holder); this.native.continuous = this.holders.has('continuous'); return }
    this.teardown()
    this.holders.add(holder)
    const generation = this.generation
    this.log = log; this.source = session ? 'glasses' : 'phone'; this.session = session; this.packets = 0; this.capturing = true
    this.completion = new Promise(resolve => { this.resolveCompletion = resolve })
    const startError = this.startNative(voice, endpointing, !session)
    if (startError) { this.teardown(); this.setStatus(startError); this.emitEnd(); return }
    if (!session) { log(`Voice: phone default microphone enabled; using ${this.recognition} recognition`); return }
    try {
      await session.setMicrophone(true, packet => {
        if (generation !== this.generation || !this.capturing) return
        this.packets++
        const copy = new Uint8Array(packet)
        this.native.acceptPacket(NSData.dataWithBytesLength(interop.handleof(copy.buffer), copy.byteLength))
      })
      if (generation !== this.generation || !this.capturing) return
      log(`Voice: glasses microphone enabled; using ${this.recognition} recognition`)
      this.audioTimer = setTimeout(() => {
        this.audioTimer = null
        if (generation === this.generation && this.capturing && !this.packets) {
          this.teardown(); this.setStatus('No microphone audio received. Reconnect the glasses and try again.'); this.emitEnd()
        }
      }, 5000)
    } catch (error) {
      if (generation !== this.generation) return
      this.teardown(); this.setStatus(error instanceof Error ? error.message : String(error)); this.emitEnd()
    }
  }
  /** Starts the native capture for the chosen provider; returns an actionable error, or ''. */
  private startNative(voice: VoiceProviderSelection, endpointing: boolean, phone: boolean): string {
    const native = this.ensureNative()
    const generation = this.generation
    const current = () => generation === this.generation
    const callbacks = {
      onTranscript: (event: CloudSttTranscriptEvent) => { if (current()) this.receiveCloudTranscript(event) },
      onStatus: (status: string) => { if (current()) this.setStatus(status) },
      onError: (message: string) => { if (current()) { this.teardown(); this.setStatus(message); this.emitEnd() } },
    }
    const continuous = () => this.holders.has('continuous')
    const model = onboardModel(voice.provider)
    if (model && onboardModelError(model)) return onboardModelError(model)
    const cloud = model
      ? new ReconnectingSttClient(options => createOnboardSttClient(model, options), { ...callbacks, apiKey: '' }, continuous)
      : createCloudSttClient(voice, callbacks, continuous)
    this.recognition = model ? `on-device ${model}` : cloud ? 'cloud' : 'on-device'
    native.continuous = this.holders.has('continuous'); native.saveRecording = !!voice.saveRecording
    if (!cloud) return String((phone ? native.startPhoneWithEndpointing(endpointing) : native.startWithEndpointing(endpointing)) ?? '')
    const error = String(native.startPcmCaptureWithEndpointingPhone(endpointing, phone) ?? '')
    if (error) return error
    this.cloud = cloud
    // "My voice only" (Microphones), as Android's controller passes it (speakers.ts).
    const verification = this.holders.has('continuous') ? null : wearerVerificationOptions()
    this.verifier = verification ? createSpeakerVerifier(verification) : null
    cloud.start()
    return ''
  }
  stopPhoneCapture(): void {
    if (this.source !== 'phone') return
    this.teardown(); this.setStatus('Phone voice input stopped.'); this.emitEnd()
  }
  stopPushToTalk(): Promise<void> {
    const completion = this.completion
    // Continuous capture keeps the shared stream; its finals reach the dialog too.
    if (this.holders.has('continuous')) { this.holders.delete('ptt'); return Promise.resolve() }
    if (!this.capturing) return completion
    this.holders.clear()
    this.capturing = false; this.finalizing = true
    this.clearAudioTimer(); this.releaseMicrophone()
    this.setStatus('Recognizing…'); this.native?.finish()
    return completion
  }
  /** Cancels push-to-talk (the voice dialog closed); a continuous holder keeps the mic. */
  stop(): void {
    if (this.holders.has('continuous')) { this.holders.delete('ptt'); return }
    this.teardown()
  }
  private teardown(): void {
    ++this.generation
    this.holders.clear()
    this.capturing = this.finalizing = false
    this.source = null
    this.clearAudioTimer(); this.releaseMicrophone(); this.native?.cancel()
    this.clearCloud()
    this.finishCompletion()
  }
  handleSessionEnded(message = 'Glasses disconnected. Start voice input again after reconnecting.'): void {
    this.endRawTap(true)
    if (this.source !== 'glasses' || !this.capturing && !this.finalizing) return
    const park = this.holders.has('continuous')
    this.teardown()
    if (park) this.suspended.add('continuous')
    this.setStatus(park ? 'Waiting for the glasses...' : message); this.emitEnd()
  }
  private clearAudioTimer(): void { if (this.audioTimer !== null) clearTimeout(this.audioTimer); this.audioTimer = null }
  private releaseMicrophone(): void {
    const session = this.session; this.session = null
    if (session) void session.setMicrophone(false).catch(error => this.log(`Voice microphone cleanup: ${error}`))
  }
  private clearCloud(): void {
    if (this.cloudTimer !== null) clearTimeout(this.cloudTimer)
    this.cloudTimer = null
    this.cloud?.stop(); this.cloud = null; this.cloudEndStatus = null; this.verifier = null
  }
  /** The native audio has ended; have the provider finalize what it heard. */
  private finishCloud(status: string): void {
    this.capturing = false; this.finalizing = true
    this.cloudEndStatus = status
    this.setStatus('Recognizing…')
    // Armed first: finish() can deliver the final synchronously.
    this.cloudTimer = setTimeout(() => this.completeCloud(), CLOUD_FINAL_TIMEOUT_MS)
    void this.verifier?.verdict()
    this.cloud?.finish()
  }
  private completeCloud(): void {
    const status = this.cloudEndStatus ?? 'Ready to send'
    this.clearCloud()
    this.holders.clear()
    this.capturing = this.finalizing = false
    this.finishCompletion()
    this.setStatus(status); this.emitEnd()
  }
  private receiveCloudTranscript(event: CloudSttTranscriptEvent): void {
    if (!this.capturing && !this.finalizing) return
    // The verdict is pending only once the audio ended: hold the final for it.
    const verifier = this.verifier
    if (event.isFinal && verifier && this.cloudEndStatus !== null) {
      const generation = this.generation
      void verifier.verdict().then(({ isWearer, similarity }) => {
        if (generation !== this.generation || this.verifier !== verifier) return
        this.verifier = null
        if (!isWearer) this.cloudEndStatus = `Ignored — not your enrolled voice (match ${Math.round(similarity * 100)}%).`
        this.receiveCloudTranscript(isWearer ? event : { text: '', isFinal: true })
      })
      return
    }
    for (const fn of [...this.transcripts]) fn(event)
    // Push-to-talk commits once, so the first final after it is the last.
    if (event.isFinal && this.cloudEndStatus !== null) this.completeCloud()
  }
  private emitEnd(): void { for (const fn of [...this.ends]) fn() }
  private finishCompletion(): void {
    const resolve = this.resolveCompletion; this.resolveCompletion = null; resolve?.()
  }
  private receive(event: { kind: string; text?: string; final?: boolean; message?: string; seconds?: number; packets?: number; rms?: number; missing?: number; errors?: number }): void {
    if (!this.capturing && !this.finalizing) return
    if (event.kind === 'transcript') {
      this.log(`Voice: ${event.final ? 'final' : 'partial'} transcript (${event.text?.length ?? 0} characters)`)
      for (const fn of [...this.transcripts]) fn({ text: event.text ?? '', isFinal: !!event.final })
    } else if (event.kind === 'status') this.setStatus(event.message ?? '')
    else if (event.kind === 'audio') {
      this.log(`Voice audio: ${event.seconds?.toFixed(1)}s, packets=${event.packets}, RMS=${event.rms?.toFixed(4)}, missing=${event.missing}, errors=${event.errors}`)
      // A cloud provider's own status (connecting, listening, reconnecting) stays up.
      if (this.capturing && !this.cloud) this.setStatus(`Listening on ${this.source === 'phone' ? 'phone' : 'glasses'}… ${event.seconds?.toFixed(0)}s`)
    } else if (event.kind === 'pause') for (const fn of [...this.pauses]) fn()
    else if (event.kind === 'finishing') {
      if (this.holders.has('continuous')) return
      void this.stopPushToTalk(); this.emitEnd()
    } else if (event.kind === 'ended') {
      this.source = null
      this.clearAudioTimer(); this.releaseMicrophone()
      if (this.cloud) { this.finishCloud(event.message ?? 'Ready to send'); return }
      this.holders.clear()
      this.capturing = this.finalizing = false
      this.finishCompletion()
      this.setStatus(event.message ?? 'Ready to send'); this.emitEnd()
    }
  }
}
export const voiceControlBridge = new IosVoiceControlBridge()
