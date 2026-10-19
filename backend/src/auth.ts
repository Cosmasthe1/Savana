import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

const scrypt = (pw: string, salt: Buffer, len: number) =>
  new Promise<Buffer>((res, rej) => scryptCb(pw, salt, len, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [s, h] = stored.split(':');
  if (!s || !h) return false;
  const expected = Buffer.from(h, 'hex');
  const actual = await scrypt(pw, Buffer.from(s, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}
