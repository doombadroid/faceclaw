/**
 * Listen's pause detector. SpeechTranscribers finalize on their own schedule (seconds late, and
 * each language splits speech differently), so Listen finds the pauses itself and asks both
 * transcribers to finalize through each one: their finals then cover the same stretch of audio.
 * Energy-based on 16 kHz mono S16LE: a frame is speech when it is marginDb above the tracked noise
 * floor. Pure (no NativeScript imports) so it runs under plain node for the tests.
 */

const SAMPLE_RATE = 16000

export interface EndpointOptions {
  frameMs?: number
  /** Speech shorter than this is a click or a cough, not an utterance. */
  minSpeechMs?: number
  /** Silence that ends an utterance. */
  pauseMs?: number
  /** Continuous speech longer than this is cut anyway, so a monologue still gets captions. */
  maxSegmentS?: number
  marginDb?: number
}

export class Endpointer {
  private readonly frame: number
  private readonly minSpeech: number
  private readonly pause: number
  private readonly maxSegment: number
  private readonly margin: number
  private carry = new Int16Array(0)
  private t = 0 // seconds of audio seen
  private floor = -50 // dBFS noise floor
  private speechMs = 0
  private silenceMs = 0
  private segmentStart = -1 // first speech frame of the open utterance, -1 when none
  private lastSpeechEnd = 0
  /** ponytail: debug — last 2 s of frame levels (dBFS) and the floor, logged at each pause while tuning; drop before merging. */
  readonly recentDb: number[] = []
  get floorDb(): number { return this.floor }

  constructor(opts: EndpointOptions = {}) {
    this.frame = Math.round(SAMPLE_RATE * (opts.frameMs ?? 50) / 1000)
    this.minSpeech = opts.minSpeechMs ?? 250
    this.pause = opts.pauseMs ?? 550
    this.maxSegment = opts.maxSegmentS ?? 12
    this.margin = opts.marginDb ?? 10
  }

  /** Feed PCM in arrival order; returns the audio times (s) at which an utterance ended. */
  push(pcm: Uint8Array): number[] {
    const samples = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + (pcm.byteLength & ~1)))
    const all = new Int16Array(this.carry.length + samples.length)
    all.set(this.carry)
    all.set(samples, this.carry.length)
    const out: number[] = []
    let i = 0
    for (; i + this.frame <= all.length; i += this.frame) {
      const b = this.step(all.subarray(i, i + this.frame))
      if (b !== null) out.push(b)
    }
    this.carry = all.slice(i)
    return out
  }

  private step(frame: Int16Array): number | null {
    let sum = 0
    for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!
    const db = 10 * Math.log10(sum / frame.length / (32768 * 32768) + 1e-12)
    this.recentDb.push(Math.round(db))
    if (this.recentDb.length > 40) this.recentDb.shift()
    const ms = frame.length * 1000 / SAMPLE_RATE
    const start = this.t
    this.t += frame.length / SAMPLE_RATE
    const speech = db > this.floor + this.margin
    // Floor: falls at once to quieter frames, creeps up through non-speech (a noisier room).
    if (db < this.floor) this.floor = db
    else if (!speech) this.floor += 0.05
    if (speech) {
      if (this.segmentStart < 0) { this.segmentStart = start; this.speechMs = 0 }
      this.speechMs += ms
      this.silenceMs = 0
      this.lastSpeechEnd = this.t
      if (this.t - this.segmentStart >= this.maxSegment) return this.close(this.t)
      return null
    }
    if (this.segmentStart < 0) return null
    this.silenceMs += ms
    if (this.silenceMs < this.pause) return null
    if (this.speechMs < this.minSpeech) { this.segmentStart = -1; return null }
    // A little after the last speech frame, so the final word's tail is inside.
    return this.close(Math.min(this.t, this.lastSpeechEnd + 0.15))
  }

  private close(at: number): number {
    this.segmentStart = -1
    this.speechMs = 0
    this.silenceMs = 0
    return at
  }
}
