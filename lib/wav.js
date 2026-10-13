/**
 * WAV 编解码与 base64 工具。
 *
 * 宿主半区与客户端半区共用这一份实现：
 * - 客户端把麦克风音频重采样后用它编出 **canonical WAV**；
 * - 宿主半区在送去识别前用它校验时长、采样率与大小，避免把坏数据丢给模型。
 *
 * DSH 的 `speechController.transcribe` 要求的正是
 * `{ audioBase64: string }`（canonical WAV 的 base64）。
 *
 * 本模块不依赖 Node，也不依赖浏览器：用特性探测在两边都跑得通。
 */

const hasBuffer = typeof globalThis.Buffer !== 'undefined' && typeof globalThis.Buffer.from === 'function'

/** 每样本字节数（16-bit PCM）。 */
const BYTES_PER_SAMPLE = 2

/**
 * 字节数组 → base64。
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  if (hasBuffer) return globalThis.Buffer.from(bytes).toString('base64')
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk))
  }
  return globalThis.btoa(binary)
}

/**
 * base64 → 字节数组。
 * @param {string} text
 * @returns {Uint8Array}
 */
export function base64ToBytes(text) {
  if (hasBuffer) return new Uint8Array(globalThis.Buffer.from(text, 'base64'))
  const binary = globalThis.atob(text)
  const out = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index)
  return out
}

/**
 * 把单声道浮点样本编成 16-bit PCM 的 canonical WAV。
 *
 * @param {{ samples: Float32Array | number[], sampleRate: number }} input
 * @returns {Uint8Array}
 */
export function encodeWav(input) {
  const samples = input.samples
  const sampleRate = Math.round(input.sampleRate)
  const frameCount = samples.length
  const dataBytes = frameCount * BYTES_PER_SAMPLE
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)

  const writeAscii = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index))
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt 块长度
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // 单声道
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true) // 字节率
  view.setUint16(32, BYTES_PER_SAMPLE, true) // 块对齐
  view.setUint16(34, 16, true) // 位深
  writeAscii(36, 'data')
  view.setUint32(40, dataBytes, true)

  for (let index = 0; index < frameCount; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]))
    // 非对称映射：负数到 -32768，正数到 32767
    view.setInt16(44 + index * BYTES_PER_SAMPLE, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }

  return new Uint8Array(buffer)
}

/**
 * 解析 WAV 头（会真实遍历 chunk，不假设固定 44 字节头）。
 *
 * @param {Uint8Array} bytes
 * @returns {{
 *   ok: boolean, reason?: string, sampleRate: number, channels: number,
 *   bitsPerSample: number, audioFormat: number, dataBytes: number, durationSeconds: number,
 * }}
 */
export function parseWav(bytes) {
  const fail = (reason) => ({
    ok: false,
    reason,
    sampleRate: 0,
    channels: 0,
    bitsPerSample: 0,
    audioFormat: 0,
    dataBytes: 0,
    durationSeconds: 0,
  })

  if (!(bytes instanceof Uint8Array) || bytes.length < 44) return fail('音频太短，不是合法 WAV。')

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (offset, length) => {
    let text = ''
    for (let index = 0; index < length; index += 1) text += String.fromCharCode(view.getUint8(offset + index))
    return text
  }

  if (ascii(0, 4) !== 'RIFF') return fail('缺少 RIFF 标记。')
  if (ascii(8, 4) !== 'WAVE') return fail('缺少 WAVE 标记。')

  let offset = 12
  let audioFormat = 0
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let dataBytes = 0
  let sawFormat = false

  while (offset + 8 <= bytes.length) {
    const chunkId = ascii(offset, 4)
    const chunkSize = view.getUint32(offset + 4, true)
    const body = offset + 8

    if (chunkId === 'fmt ') {
      if (body + 16 > bytes.length) return fail('fmt 块被截断。')
      audioFormat = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bitsPerSample = view.getUint16(body + 14, true)
      sawFormat = true
    } else if (chunkId === 'data') {
      // data 块常常没有按 chunkSize 补齐，因此以实际剩余字节为准
      dataBytes = Math.min(chunkSize, bytes.length - body)
      break
    }

    // chunk 按偶数字节对齐
    offset = body + chunkSize + (chunkSize % 2)
  }

  if (!sawFormat) return fail('缺少 fmt 块。')
  if (audioFormat !== 1) return fail(`只支持 PCM（audioFormat=1），收到 ${audioFormat}。`)
  if (channels < 1) return fail('声道数为 0。')
  if (sampleRate < 8000) return fail(`采样率过低：${sampleRate}。`)
  if (bitsPerSample !== 16) return fail(`只支持 16-bit，收到 ${bitsPerSample}-bit。`)
  if (dataBytes === 0) return fail('没有音频数据。')

  const durationSeconds = dataBytes / (sampleRate * channels * BYTES_PER_SAMPLE)

  return { ok: true, sampleRate, channels, bitsPerSample, audioFormat, dataBytes, durationSeconds }
}

/**
 * 把任意采样率的单声道样本线性重采样到目标采样率。
 *
 * 线性插值对 16 kHz 语音识别足够；这里刻意不引入重采样库，保持零依赖。
 *
 * @param {Float32Array} samples
 * @param {number} sourceRate
 * @param {number} targetRate
 * @returns {Float32Array}
 */
export function resampleLinear(samples, sourceRate, targetRate) {
  if (sourceRate === targetRate || samples.length === 0) return samples
  const ratio = targetRate / sourceRate
  const outLength = Math.max(1, Math.round(samples.length * ratio))
  const out = new Float32Array(outLength)
  for (let index = 0; index < outLength; index += 1) {
    const position = index / ratio
    const left = Math.floor(position)
    const right = Math.min(left + 1, samples.length - 1)
    const weight = position - left
    out[index] = samples[left] * (1 - weight) + samples[right] * weight
  }
  return out
}

/**
 * 多声道交错样本 → 单声道。
 * @param {Float32Array} interleaved
 * @param {number} channels
 * @returns {Float32Array}
 */
export function toMono(interleaved, channels) {
  if (channels <= 1) return interleaved
  const frames = Math.floor(interleaved.length / channels)
  const out = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0
    for (let channel = 0; channel < channels; channel += 1) sum += interleaved[frame * channels + channel]
    out[frame] = sum / channels
  }
  return out
}

/**
 * 校验一段 base64 WAV 是否可以被安全地送去识别。
 *
 * @param {string} audioBase64
 * @param {{ maxBytes?: number, maxSeconds?: number }} [limits]
 * @returns {{ ok: boolean, reason?: string, bytes: number, durationSeconds: number, sampleRate: number }}
 */
export function validateTranscriptionAudio(audioBase64, limits = {}) {
  if (typeof audioBase64 !== 'string' || audioBase64 === '') {
    return { ok: false, reason: '缺少音频数据。', bytes: 0, durationSeconds: 0, sampleRate: 0 }
  }
  // base64 的字节数≈长度×3/4，先做一次廉价的大小检查，避免解码超大载荷
  const approximateBytes = Math.floor((audioBase64.length * 3) / 4)
  const maxBytes = Number.isFinite(limits.maxBytes) ? limits.maxBytes : 8 * 1024 * 1024
  if (approximateBytes > maxBytes) {
    return {
      ok: false,
      reason: `音频过大（约 ${approximateBytes} 字节，上限 ${maxBytes}）。`,
      bytes: approximateBytes,
      durationSeconds: 0,
      sampleRate: 0,
    }
  }

  let bytes
  try {
    bytes = base64ToBytes(audioBase64)
  } catch {
    return { ok: false, reason: 'base64 解码失败。', bytes: 0, durationSeconds: 0, sampleRate: 0 }
  }

  const parsed = parseWav(bytes)
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason, bytes: bytes.length, durationSeconds: 0, sampleRate: 0 }
  }

  if (parsed.channels !== 1) {
    return {
      ok: false,
      reason: `需要单声道音频，收到 ${parsed.channels} 声道。`,
      bytes: bytes.length,
      durationSeconds: parsed.durationSeconds,
      sampleRate: parsed.sampleRate,
    }
  }

  const maxSeconds = Number.isFinite(limits.maxSeconds) ? limits.maxSeconds : 120
  if (parsed.durationSeconds > maxSeconds) {
    return {
      ok: false,
      reason: `录音过长（${parsed.durationSeconds.toFixed(1)} 秒，上限 ${maxSeconds} 秒）。`,
      bytes: bytes.length,
      durationSeconds: parsed.durationSeconds,
      sampleRate: parsed.sampleRate,
    }
  }

  return {
    ok: true,
    bytes: bytes.length,
    durationSeconds: parsed.durationSeconds,
    sampleRate: parsed.sampleRate,
  }
}
