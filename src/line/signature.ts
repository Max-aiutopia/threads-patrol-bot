// LINE webhook 簽章驗證。
// 規則（https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/）：
// 以 channel secret 為 key，對「原始 request body 字串」做 HMAC-SHA256，轉 Base64，跟 x-line-signature 比。
// 驗證前不能 JSON.parse、不能改動 body，否則一定對不上。
import { hmacSha256Base64, timingSafeEqual } from '../lib/crypto';

export async function verifyLineSignature(rawBody: string, signature: string | null, channelSecret: string): Promise<boolean> {
  if (!signature || !channelSecret) return false;
  const expected = await hmacSha256Base64(channelSecret, rawBody);
  return timingSafeEqual(expected, signature.trim());
}
