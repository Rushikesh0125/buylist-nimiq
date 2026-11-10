import { blake2b } from "@noble/hashes/blake2.js";
import { hexToBytes } from "@noble/hashes/utils.js";

const alphabet = "0123456789ABCDEFGHJKLMNPQRSTUVXY";

export function addressFromPublicKey(publicKey: string) {
  const raw = blake2b(hexToBytes(publicKey), { dkLen: 32 }).subarray(0, 20);
  let buffer = 0;
  let bits = 0;
  let encoded = "";
  for (const byte of raw) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += alphabet[(buffer >> bits) & 31];
    }
  }
  let remainder = 0;
  for (const character of encoded + "NQ00") {
    const digit = parseInt(character, 36);
    remainder = (remainder * (digit < 10 ? 10 : 100) + digit) % 97;
  }
  const checksum = String(98 - remainder).padStart(2, "0");
  return ("NQ" + checksum + encoded).match(/.{4}/g)!.join(" ");
}
