import { Http } from '@nativescript/core';
import { withUserAgent } from '../util/http';
import type { BinaryResponse } from './binary-http';

/** Bulk NSData -> ArrayBuffer; bypass fetch's Blob/FileReader copies. */
export async function downloadBinary(url: string, timeoutMs: number): Promise<BinaryResponse> {
  const response = await Http.request({ url, method: 'GET', headers: withUserAgent(), timeout: timeoutMs });
  const length = Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'content-length')?.[1];
  if (!response.content) throw new Error(`no response body from ${url}`);
  return { status: response.statusCode, bytes: new Uint8Array(response.content.toArrayBuffer()).slice(), contentLength: Number(length ?? 0) };
}
