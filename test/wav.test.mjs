import test from 'node:test'
import assert from 'node:assert/strict'

import {
  base64ToBytes,
  bytesToBase64,
  encodeWav,
  parseWav,
  resampleLinear,
  toMono,
  validateTranscriptionAudio,
} from '../lib/wav.js'

/** 造一段正弦波，用来做编解码往返。 */
function tone(frames, sampleRate, frequency = 440) {
  const samples = new Float32Array(frames)
  for (let index = 0; index < frames; index += 1) {
    samples[index] = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.6
  }
  return samples
}

test('base64 往返是无损的', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
  const roundTrip = base64ToBytes(bytesToBase64(bytes))
  assert.deepEqual(Array.from(roundTrip), Array.from(bytes))
})

test('base64 往返能处理超过单次 fromCharCode 上限的长度', () => {
  const bytes = new Uint8Array(200_000)
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 256
  const roundTrip = base64ToBytes(bytesToBase64(bytes))
  assert.equal(roundTrip.length, bytes.length)
  assert.equal(roundTrip[123_456], bytes[123_456])
})

test('encodeWav 产出的头部是规范的 44 字节 RIFF', () => {
  const samples = tone(1600, 16000)
  const wav = encodeWav({ samples, sampleRate: 16000 })
  assert.equal(wav.length, 44 + 1600 * 2)

  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  const ascii = (offset, length) =>
    Array.from({ length }, (_, index) => String.fromCharCode(view.getUint8(offset + index))).join('')

  assert.equal(ascii(0, 4), 'RIFF')
  assert.equal(ascii(8, 4), 'WAVE')
  assert.equal(ascii(12, 4), 'fmt ')
  assert.equal(ascii(36, 4), 'data')
  assert.equal(view.getUint32(4, true), 36 + 1600 * 2, 'RIFF 长度字段')
  assert.equal(view.getUint16(20, true), 1, 'PCM')
  assert.equal(view.getUint16(22, true), 1, '单声道')
  assert.equal(view.getUint32(24, true), 16000)
  assert.equal(view.getUint16(34, true), 16, '16-bit')
})

test('encodeWav → parseWav 往返一致', () => {
  const sampleRate = 16000
  const wav = encodeWav({ samples: tone(sampleRate, sampleRate), sampleRate })
  const parsed = parseWav(wav)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.sampleRate, sampleRate)
  assert.equal(parsed.channels, 1)
  assert.equal(parsed.bitsPerSample, 16)
  assert.equal(parsed.audioFormat, 1)
  assert.equal(parsed.dataBytes, sampleRate * 2)
  assert.ok(Math.abs(parsed.durationSeconds - 1) < 1e-6)
})

test('encodeWav 把样本夹在 [-1, 1] 内（不会回绕成噪声）', () => {
  const samples = new Float32Array([2, -2, 0])
  const wav = encodeWav({ samples, sampleRate: 16000 })
  const view = new DataView(wav.buffer)
  assert.equal(view.getInt16(44, true), 32767, '正溢出夹到最大正数')
  assert.equal(view.getInt16(46, true), -32768, '负溢出夹到最小负数')
  assert.equal(view.getInt16(48, true), 0)
})

test('parseWav 能处理带额外 chunk 的 WAV（不假设 44 字节头）', () => {
  // 手工拼一个 fmt + LIST + data 的 WAV
  const extra = 'LIST'
  const listBody = 8
  const dataBytes = 320
  const total = 12 + (8 + 16) + (8 + listBody) + (8 + dataBytes)
  const buffer = new ArrayBuffer(total)
  const view = new DataView(buffer)
  const put = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index))
  }
  put(0, 'RIFF')
  view.setUint32(4, total - 8, true)
  put(8, 'WAVE')
  put(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  put(36, extra)
  view.setUint32(40, listBody, true)
  put(52, 'data')
  view.setUint32(56, dataBytes, true)

  const parsed = parseWav(new Uint8Array(buffer))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.dataBytes, dataBytes)
  assert.ok(Math.abs(parsed.durationSeconds - 0.01) < 1e-6)
})

test('parseWav 明确拒绝各种坏输入', () => {
  assert.equal(parseWav(new Uint8Array(10)).ok, false)
  assert.match(parseWav(new Uint8Array(10)).reason, /太短/)

  const notRiff = new Uint8Array(44)
  notRiff.set([0x4e, 0x4f, 0x50, 0x45], 0) // "NOPE"
  assert.match(parseWav(notRiff).reason, /RIFF/)

  const floats = encodeWav({ samples: tone(100, 16000), sampleRate: 16000 })
  const view = new DataView(floats.buffer)
  view.setUint16(20, 3, true) // IEEE float
  assert.match(parseWav(floats).reason, /PCM/)

  const eightBit = encodeWav({ samples: tone(100, 16000), sampleRate: 16000 })
  new DataView(eightBit.buffer).setUint16(34, 8, true)
  assert.match(parseWav(eightBit).reason, /16-bit/)

  const lowRate = encodeWav({ samples: tone(100, 16000), sampleRate: 16000 })
  new DataView(lowRate.buffer).setUint32(24, 4000, true)
  assert.match(parseWav(lowRate).reason, /采样率过低/)
})

test('validateTranscriptionAudio 接受规范的单声道 WAV', () => {
  const wav = encodeWav({ samples: tone(16000, 16000), sampleRate: 16000 })
  const result = validateTranscriptionAudio(bytesToBase64(wav))
  assert.equal(result.ok, true)
  assert.equal(result.sampleRate, 16000)
  assert.ok(Math.abs(result.durationSeconds - 1) < 1e-6)
})

test('validateTranscriptionAudio 拒绝空值、坏 base64 与超长录音', () => {
  assert.equal(validateTranscriptionAudio('').ok, false)
  assert.equal(validateTranscriptionAudio(undefined).ok, false)
  assert.match(validateTranscriptionAudio('!!!not-base64!!!').reason, /WAV|RIFF|太短|解码/)

  const wav = encodeWav({ samples: tone(16000 * 5, 16000), sampleRate: 16000 })
  const tooLong = validateTranscriptionAudio(bytesToBase64(wav), { maxSeconds: 2 })
  assert.equal(tooLong.ok, false)
  assert.match(tooLong.reason, /录音过长/)
})

test('validateTranscriptionAudio 拒绝立体声与超大载荷', () => {
  const wav = encodeWav({ samples: tone(1000, 16000), sampleRate: 16000 })
  new DataView(wav.buffer).setUint16(22, 2, true)
  const stereo = validateTranscriptionAudio(bytesToBase64(wav))
  assert.equal(stereo.ok, false)
  assert.match(stereo.reason, /单声道/)

  const big = validateTranscriptionAudio(bytesToBase64(encodeWav({ samples: tone(20000, 16000), sampleRate: 16000 })), {
    maxBytes: 1000,
  })
  assert.equal(big.ok, false)
  assert.match(big.reason, /过大/)
})

test('resampleLinear 长度与首尾正确', () => {
  const input = tone(4800, 48000)
  const output = resampleLinear(input, 48000, 16000)
  assert.equal(output.length, 1600)
  // 首样本在两种采样率下都接近 0
  assert.ok(Math.abs(output[0]) < 0.05)
  assert.equal(resampleLinear(input, 16000, 16000), input, '同采样率应原样返回')
  assert.equal(resampleLinear(new Float32Array(0), 48000, 16000).length, 0)
})

test('resampleLinear 保留信号的峰值量级', () => {
  const input = tone(48000, 48000)
  const output = resampleLinear(input, 48000, 16000)
  let peak = 0
  for (const value of output) peak = Math.max(peak, Math.abs(value))
  assert.ok(peak > 0.5 && peak <= 0.61, `峰值应保持在原信号附近，实际 ${peak}`)
})

test('toMono 对多声道做平均', () => {
  const stereo = new Float32Array([1, 0, 0.5, 0.5, -1, 1])
  const mono = toMono(stereo, 2)
  assert.equal(mono.length, 3)
  assert.equal(mono[0], 0.5)
  assert.equal(mono[1], 0.5)
  assert.equal(mono[2], 0)
  const already = new Float32Array([1, 2])
  assert.equal(toMono(already, 1), already)
})
