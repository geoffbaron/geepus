import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureBundledModel } from './bundled';

function fakeGgufResponse(bytes: Uint8Array): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-length': String(bytes.length) } });
}

describe('ensureBundledModel', () => {
  let dir: string;
  const fakeBytes = new TextEncoder().encode('fake gguf contents for testing');
  const fakeSha256 = createHash('sha256').update(fakeBytes).digest('hex');
  const fakeSource = { url: 'https://example.test/fake.gguf', expectedSha256: fakeSha256, expectedSizeBytes: fakeBytes.length };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geepus-bundled-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('uses the baked path as-is when present, without downloading', async () => {
    const bakedPath = join(dir, 'baked.gguf');
    await writeFile(bakedPath, 'baked model bytes');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await ensureBundledModel({ cachePath: join(dir, 'cache.gguf'), bakedPath, ...fakeSource });
    expect(result).toBe(bakedPath);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reuses an already-cached file whose checksum matches instead of re-downloading', async () => {
    const cachePath = join(dir, 'cache.gguf');
    await writeFile(cachePath, fakeBytes);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await ensureBundledModel({ cachePath, ...fakeSource });
    expect(result).toBe(cachePath);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('downloads, verifies, and installs the model when nothing is cached (including creating nested dirs)', async () => {
    const cachePath = join(dir, 'nested', 'cache.gguf');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeGgufResponse(fakeBytes)));

    const result = await ensureBundledModel({ cachePath, ...fakeSource });
    expect(result).toBe(cachePath);
    expect(await readFile(cachePath)).toEqual(Buffer.from(fakeBytes));
  });

  it('discards a corrupted cache file and re-downloads a good copy', async () => {
    const cachePath = join(dir, 'cache.gguf');
    await writeFile(cachePath, 'corrupted garbage that will not match the checksum');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeGgufResponse(fakeBytes)));

    const result = await ensureBundledModel({ cachePath, ...fakeSource });
    expect(result).toBe(cachePath);
    expect(await readFile(cachePath)).toEqual(Buffer.from(fakeBytes));
  });

  it('throws and does not install the file when the download does not match the expected checksum', async () => {
    const cachePath = join(dir, 'cache.gguf');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fakeGgufResponse(new TextEncoder().encode('completely different bytes'))),
    );

    await expect(ensureBundledModel({ cachePath, ...fakeSource })).rejects.toThrow(/checksum mismatch/);
    await expect(readFile(cachePath)).rejects.toThrow();
  });

  it('reports download progress via onProgress', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeGgufResponse(fakeBytes)));
    const onProgress = vi.fn();

    await ensureBundledModel({ cachePath: join(dir, 'cache.gguf'), onProgress, ...fakeSource });

    expect(onProgress).toHaveBeenCalledWith(fakeBytes.length, fakeBytes.length);
  });
});
