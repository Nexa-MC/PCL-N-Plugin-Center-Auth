import { randomBytes } from 'node:crypto';
import { generateCandidates, generateNonce } from './encoder.mjs';
import { ENGLISH_CAPACITY, unrankEnglish } from './english-encoder.mjs';

export const BINDING_ENCODER_VERSION = 'bili-zh80-en64-v2';
export const ENGLISH_NONCE_LIMIT = 1n << 64n;
export const ENGLISH_SPACES = [(ENGLISH_CAPACITY + 1n) / 2n, ENGLISH_CAPACITY / 2n];
if (ENGLISH_SPACES.some(space => space < ENGLISH_NONCE_LIMIT)) throw new Error('English grammar must supply at least 64 bits per candidate after length and semantic restrictions');
export const createBindingNonces = () => ({ zh: generateNonce(), en: randomBytes(8).toString('hex') });
export function generateBindingCandidates(nonces) {
  if (!/^[\da-f]{20}$/i.test(nonces?.zh) || !/^[\da-f]{16}$/i.test(nonces?.en)) throw new TypeError('Expected independent 80-bit Chinese and 64-bit English nonces');
  const chinese = generateCandidates(nonces.zh).slice(0,2).map(candidate => ({ ...candidate, language: 'zh' }));
  const english = ENGLISH_SPACES.map((capacity, index) => {
    const permuted = (BigInt('0x' + nonces.en) * [1n, 0x9e3779b97f4a7c15n][index] + [0n, 0x243f6a8885a308d3n][index]) % ENGLISH_NONCE_LIMIT;
    const rank = 2n * (permuted * capacity / ENGLISH_NONCE_LIMIT) + BigInt(index);
    return { index: index + 2, language: 'en', text: unrankEnglish(rank) };
  });
  return [...chinese, ...english];
}
