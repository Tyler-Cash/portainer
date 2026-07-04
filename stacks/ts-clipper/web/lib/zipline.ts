import { readFile } from 'node:fs/promises';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export async function uploadToZipline(filePath: string, filename: string): Promise<string> {
  const token = requireEnv('ZIPLINE_TOKEN');
  const baseUrl = requireEnv('ZIPLINE_URL');

  const buffer = await readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'video/mp4' }), filename);

  const res = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: { authorization: token },
    body: form,
  });

  if (!res.ok) {
    throw new Error(`Zipline upload failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as { files?: { url: string }[] };
  const url = json.files?.[0]?.url;
  if (!url) {
    throw new Error('Zipline response missing file url');
  }
  return url;
}
