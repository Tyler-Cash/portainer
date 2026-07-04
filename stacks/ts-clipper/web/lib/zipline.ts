import { readFile } from 'node:fs/promises';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export interface ZiplineUploadResult {
  url: string;
  id: string;
}

export async function uploadToZipline(
  filePath: string,
  filename: string,
): Promise<ZiplineUploadResult> {
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

  const json = (await res.json()) as { files?: { url: string; id: string }[] };
  const file = json.files?.[0];
  if (!file?.url || !file?.id) {
    throw new Error('Zipline response missing file url/id');
  }
  return { url: file.url, id: file.id };
}

export async function deleteFromZipline(fileId: string): Promise<void> {
  const token = requireEnv('ZIPLINE_TOKEN');
  const baseUrl = requireEnv('ZIPLINE_URL');

  const res = await fetch(`${baseUrl}/api/user/files/${fileId}`, {
    method: 'DELETE',
    headers: { authorization: token },
  });

  if (!res.ok) {
    throw new Error(`Zipline delete failed: ${res.status} ${await res.text()}`);
  }
}
